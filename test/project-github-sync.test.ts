import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalProjectGitHubSyncManifest,
  diffProjectGitHubSyncItems,
  resolveProjectGitHubSyncTerminalStatus,
  toPublicProjectGitHubSyncRun,
} from "../src/lib/github/project-sync-service";
import { serializeProjectJobResult } from "../src/lib/project-workflow";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const entryId = "44444444-4444-4444-8444-444444444444";
const hash = "a".repeat(64);

test("sync diff keeps withheld identities and distinguishes safe change types", () => {
  const before = [
    { identity: "src/old.ts", normalizedPath: "src/old.ts", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
    { identity: "src/same.ts", normalizedPath: "src/same.ts", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
  ] as const;
  const after = [
    { identity: "src/same.ts", normalizedPath: "src/same.ts", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
    { identity: "src/new.ts", normalizedPath: "src/new.ts", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
  ] as const;
  const changes = diffProjectGitHubSyncItems(before, after, ["src/old.ts"]);
  assert.deepEqual(changes.map((change) => [change.identity, change.changeType]), [
    ["src/new.ts", "added"],
    ["src/old.ts", "withheld"],
    ["src/same.ts", "unchanged"],
  ]);
});

test("sync manifest fingerprint is deterministic regardless of input order", () => {
  const left = diffProjectGitHubSyncItems([
    { identity: "b", normalizedPath: "b", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
    { identity: "a", normalizedPath: "a", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
  ], []);
  const right = diffProjectGitHubSyncItems([
    { identity: "a", normalizedPath: "a", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
    { identity: "b", normalizedPath: "b", materialKind: null, remoteIdentity: null, contentHash: hash, revisionFingerprint: hash },
  ], []);
  assert.equal(canonicalProjectGitHubSyncManifest(left), canonicalProjectGitHubSyncManifest(right));
});

test("public sync mapper is a strict safe view", () => {
  const publicRun = toPublicProjectGitHubSyncRun({
    id: runId,
    projectId,
    parentJobId: jobId,
    status: "succeeded",
    stage: "terminal",
    scopeFingerprint: hash,
    manifestFingerprint: hash,
    deadlineAt: new Date("2026-08-28T00:00:00Z"),
    codeTargetCount: 1,
    materialTargetCount: 0,
    completedCodeTargetCount: 1,
    completedMaterialTargetCount: 0,
    addedCount: 1,
    updatedCount: 0,
    deletedCount: 0,
    unchangedCount: 0,
    withheldCount: 0,
    warnings: ["SAFE_WARNING", "not safe"],
    failureCode: null,
    reconciliationRequired: false,
    createdAt: new Date("2026-08-28T00:00:00Z"),
    startedAt: new Date("2026-08-28T00:00:01Z"),
    completedAt: new Date("2026-08-28T00:00:02Z"),
    entries: [{
      id: entryId,
      targetKind: "code",
      targetKey: "code:link",
      status: "succeeded",
      repositoryFullName: "acme/app",
      configVersion: 1,
      effectivePolicyVersion: 1,
      requiredForProjectSnapshot: true,
      trackedRef: "refs/heads/main",
      beforeCodeGenerationId: null,
      beforeMaterialGenerationId: null,
      childCodeBatchId: null,
      childMaterialSyncRunId: null,
      warning: null,
      failureCode: null,
      createdAt: new Date("2026-08-28T00:00:00Z"),
      startedAt: null,
      completedAt: new Date("2026-08-28T00:00:02Z"),
      credentialId: "credential-must-not-leak",
      configSnapshot: { token: "must-not-leak" },
    }],
    changes: [{
      id: "55555555-5555-4555-8555-555555555555",
      targetKind: "code",
      identity: "src/app.ts",
      changeType: "added",
      normalizedPath: "src/app.ts",
      materialKind: null,
      remoteIdentity: null,
      beforeContentHash: null,
      afterContentHash: hash,
      beforeRevisionFingerprint: null,
      afterRevisionFingerprint: hash,
      createdAt: new Date("2026-08-28T00:00:02Z"),
      contentText: "secret source",
      payload: { token: "must-not-leak" },
    }],
  } as never);
  assert.deepEqual(publicRun.warnings, ["SAFE_WARNING"]);
  assert.equal(publicRun.changes[0]?.identity, "src/app.ts");
  assert.equal("credentialId" in publicRun.entries[0]!, false);
  assert.equal("configSnapshot" in publicRun.entries[0]!, false);
  assert.equal("contentText" in publicRun.changes[0]!, false);
  assert.equal("payload" in publicRun.changes[0]!, false);
});

test("parent job serializer only keeps sync summary fields", () => {
  const serialized = serializeProjectJobResult("githubProjectSync", {
    syncRunId: runId,
    status: "succeeded",
    scopeFingerprint: hash,
    manifestFingerprint: hash,
    counts: { added: 1, updated: 2, deleted: 3, unchanged: 4, withheld: 5 },
    warnings: ["SAFE_WARNING"],
    reconciliationRequired: false,
    payload: { token: "must-not-leak" },
    configSnapshot: { token: "must-not-leak" },
  }) as Record<string, unknown>;
  assert.equal(serialized.syncRunId, runId);
  assert.equal("payload" in serialized, false);
  assert.equal("configSnapshot" in serialized, false);
});

test("root outcome mapping distinguishes optional-only, partial, and zero-success failures", () => {
  assert.equal(resolveProjectGitHubSyncTerminalStatus({ unknown: false, rateLimited: false, knownFailure: false, successfulCount: 0 }), "succeeded");
  assert.equal(resolveProjectGitHubSyncTerminalStatus({ unknown: false, rateLimited: false, knownFailure: true, successfulCount: 0 }), "failed");
  assert.equal(resolveProjectGitHubSyncTerminalStatus({ unknown: false, rateLimited: false, knownFailure: true, successfulCount: 1 }), "partial");
  assert.equal(resolveProjectGitHubSyncTerminalStatus({ unknown: false, rateLimited: true, knownFailure: true, successfulCount: 1 }), "rateLimited");
  assert.equal(resolveProjectGitHubSyncTerminalStatus({ unknown: true, rateLimited: false, knownFailure: true, successfulCount: 1 }), "unknown");
});

test("migration enforces deterministic root uniqueness and no model/provider side effects", () => {
  const migration = readFileSync(join(process.cwd(), "prisma/migrations/20260829131000_add_project_github_sync_runs/migration.sql"), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "ProjectGitHubSyncRun_active_project_key"[\s\S]*WHERE "status" IN \('queued', 'running'\)/);
  assert.match(migration, /ProjectGitHubSyncChange_run_identity_key/);
  assert.match(migration, /length\("targetKey"\) > 0/);
  assert.match(migration, /"credentialSecretFingerprint" CHAR\(64\) NOT NULL/);
  assert.match(migration, /"credentialSecretFingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /completedCodeTargetCount.*=.*codeTargetCount[\s\S]*completedMaterialTargetCount.*=.*materialTargetCount/);
  assert.match(migration, /CREATE TRIGGER "project_github_sync_entry_terminal_guard_trigger"[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/);
  assert.match(migration, /pg_trigger_depth\(\) > 1/);
  assert.doesNotMatch(migration, /WebAiGrant|ProviderCallAudit|authorization|github_pat_|ghp_/i);
});

test("root finalization stops heartbeat before CAS terminal publication and closes failures", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/github/project-sync-service.ts"), "utf8");
  const stopAt = source.indexOf("await heartbeat.stop();\n    if (heartbeat.failure");
  const rootUpdateAt = source.indexOf("projectGitHubSyncRun.updateMany", stopAt);
  assert.ok(stopAt >= 0);
  assert.ok(rootUpdateAt > stopAt);
  assert.match(source, /finally \{[\s\S]*closeProjectGitHubSyncRoot/);
  assert.match(source, /providerDispatchPending/);
  assert.doesNotMatch(source, /__all_previous__/);
});

test("project-sync runner rechecks actor after claim before heartbeat or frozen-entry work", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/github/project-sync-service.ts"), "utf8");
  const start = source.indexOf("export async function runGitHubProjectSyncJob");
  const end = source.indexOf("\nexport async function", start + 1);
  const runner = source.slice(start, end === -1 ? undefined : end);
  const claim = runner.indexOf("const claim = await claimProjectJob");
  const tryStart = runner.indexOf("  try {");
  const secondGuard = runner.indexOf("await admitProjectSyncRoot({", tryStart);
  const heartbeat = runner.indexOf("startProjectJobHeartbeat");
  const entryRead = runner.indexOf("projectGitHubSyncEntry.findMany");
  const finallyStart = runner.indexOf("  } finally {");
  assert.ok(claim >= 0);
  assert.ok(secondGuard > claim, "root access must be admitted after claim");
  assert.ok(secondGuard > tryStart, "root access admission must be inside try/catch");
  assert.ok(secondGuard < heartbeat, "actor must be rechecked before heartbeat");
  assert.ok(secondGuard < entryRead, "actor must be rechecked before post-claim entry reads");
  assert.ok(finallyStart > secondGuard);
  assert.match(runner.slice(finallyStart), /closeProjectGitHubSyncRoot[\s\S]*failProjectJob/u);
});

test("project-sync child admission precedes every client/service acquisition", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/github/project-sync-service.ts"), "utf8");
  const start = source.indexOf("export async function runGitHubProjectSyncJob");
  const runner = source.slice(start);
  const firstCodeAdmission = runner.indexOf("await admitProjectSyncChild({");
  const firstCodeService = runner.indexOf("const childService = await serviceForCode");
  const materialAdmission = runner.indexOf("await admitProjectSyncChild({", firstCodeAdmission + 1);
  const materialService = runner.indexOf("const childService = await serviceForMaterial");
  assert.ok(firstCodeAdmission >= 0);
  assert.ok(firstCodeAdmission < firstCodeService);
  assert.ok(materialAdmission >= 0);
  assert.ok(materialAdmission < materialService);
  assert.doesNotMatch(runner, /markProviderDispatched/u);
});

test("explicit project-sync reconciliation is lock-scoped and has no provider call", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/github/project-sync-service.ts"), "utf8");
  const route = readFileSync(join(process.cwd(), "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts"), "utf8");
  assert.match(service, /export async function reconcileGitHubProjectSync/);
  assert.match(service, /export async function cancelGitHubProjectSync/);
  assert.match(service, /withProjectJobAccessTransaction\(db, \{/);
  assert.match(service, /projectGitHubSyncReconciliation\.create/);
  assert.match(service, /resolution: "explicitAbandon"/);
  assert.match(route, /actor: user/);
  assert.match(route, /cancelGitHubProjectSync/);
  const reconcileStart = service.indexOf("export async function reconcileGitHubProjectSync");
  const reconcileEnd = service.indexOf("export async function getProjectGitHubSync", reconcileStart);
  assert.doesNotMatch(service.slice(reconcileStart, reconcileEnd), /loadGitHubClientForCredential|createGitHubReadOnlyClient/);
});

test("reconcile and cancel recheck access inside the lock before state reads", () => {
  const sources = [
    {
      file: "src/lib/github/project-sync-service.ts",
      functions: ["reconcileGitHubProjectSync", "cancelGitHubProjectSync"],
    },
    {
      file: "src/lib/web-memory-index.ts",
      functions: ["reconcileMemoryIndexJob", "cancelMemoryIndexJob"],
    },
  ] as const;

  for (const { file, functions } of sources) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const name of functions) {
      const start = source.indexOf(`export async function ${name}`);
      const end = source.indexOf("\nexport async function", start + 1);
      const implementation = source.slice(start, end === -1 ? undefined : end);
      const lock = implementation.indexOf("return withProjectJobAccessTransaction");
      const innerGuard = implementation.indexOf(
        file === "src/lib/github/project-sync-service.ts" ? "lockGitHubProject" : "MEMORY_INDEX_LOCK_NAMESPACE",
        lock,
      );
      const firstJobRead = implementation.indexOf("backgroundJob.findUnique", lock);
      assert.ok(start >= 0, `${file} should export ${name}`);
      assert.ok(lock >= 0, `${name} should use the access-first project job admission`);
      assert.ok(innerGuard > lock, `${name} should take the GitHub resource lock after access admission`);
      assert.ok(firstJobRead > innerGuard, `${name} should read the job after authorization and resource locking`);
    }
  }
});

test("GitHub network uncertainty is represented as unknown by both direct services", () => {
  const code = readFileSync(join(process.cwd(), "src/lib/github/code-scan-service.ts"), "utf8");
  const material = readFileSync(join(process.cwd(), "src/lib/github/material-sync-service.ts"), "utf8");
  for (const source of [code, material]) {
    assert.match(source, /GITHUB_REQUEST_TIMEOUT.*GITHUB_REQUEST_FAILED/);
    assert.match(source, /status: "unknown"/);
  }
  assert.match(code, /status: "unknown",[\s\S]*?stage: "terminal",[\s\S]*?failureCode/);
  assert.match(material, /requestDispatched === false[\s\S]*?status: "cancelled",[\s\S]*?failureCode: null/);
  assert.match(material, /const settleQueuedIneligible[\s\S]*?status: "failed",[\s\S]*?GITHUB_MATERIAL_SYNC_LINK_INELIGIBLE/);
  const syncService = readFileSync(join(process.cwd(), "src/lib/github/project-sync-service.ts"), "utf8");
  assert.match(syncService, /child\.status === "cancelled"[\s\S]*?status: "skipped"/);
});

test("sync API surfaces use the safe service boundary", () => {
  const startRoute = readFileSync(join(process.cwd(), "src/app/api/projects/[projectId]/repositories/sync/route.ts"), "utf8");
  const detailRoute = readFileSync(join(process.cwd(), "src/app/api/projects/[projectId]/github-syncs/[syncRunId]/route.ts"), "utf8");
  const control = readFileSync(join(process.cwd(), "src/app/projects/[projectId]/control/project-control-client.tsx"), "utf8");
  const detailPage = readFileSync(join(process.cwd(), "src/app/projects/[projectId]/github-syncs/[syncRunId]/page.tsx"), "utf8");
  assert.match(startRoute, /runGitHubProjectSyncJob/);
  assert.match(startRoute, /inputSchema.*strict/);
  assert.doesNotMatch(startRoute, /backgroundJob\.(create|find|update)|payload/);
  assert.match(detailRoute, /getProjectGitHubSync/);
  assert.doesNotMatch(detailRoute, /backgroundJob|leaseToken|webAiGrantId|idempotencyKey/);
  assert.match(control, /协调确认\/关闭未知结果/);
  assert.match(control, /不会重试，也不会调用 GitHub/);
  assert.match(detailPage, /返回上一级/);
  assert.match(detailPage, /返回通知中心/);
  assert.match(detailPage, /fromNotifications/);
  assert.match(detailPage, /\/repositories/);
  assert.match(detailPage, /projectSection="repositories"/);
  assert.match(detailPage, /new Map\(sync\.entries\.map\(\(entry\) => \[entry\.targetKey, entry\.repositoryFullName\]\)\)/);
  assert.match(detailPage, /repositoryByTargetKey\.get\(change\.targetKey\)/);
});
