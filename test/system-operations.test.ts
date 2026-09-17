import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { readBackupOperationsSnapshot } from "@/lib/system-operations";
import { handleBackupOperationsGet } from "@/lib/system-operations-route";
import type { BackupOperationsSnapshot, PublicBackupRun, PublicRecoveryDrill } from "@/lib/system-operations-types";

const initialAdminId = "d348244a-24b9-4893-9afb-164f3618d93e";
const otherAdminId = "b04f05ab-5567-4e9c-b0cd-5d9e0c3e5608";
const sessionToken = "a".repeat(48);

const successfulRun: PublicBackupRun = {
  formatVersion: 1,
  runId: "20260902T032000Z-1234",
  state: "succeeded",
  trigger: "daily",
  targetTag: null,
  startedAt: "2026-09-02T03:20:00+08:00",
  completedAt: "2026-09-02T03:20:42+08:00",
  durationSeconds: 42,
  backupName: "20260901T192205Z-daily.mtJDvd",
  archiveObject: "cos://ai-project-os-backup-1306016679/production/backups/2026/09/01/20260901T192205Z-daily.mtJDvd/20260901T192205Z-daily.mtJDvd.tar.age",
  archiveSha256: "a".repeat(64),
  archiveBytes: 2_058_936,
  retentionRemoved: 1,
  verificationAttempts: 4,
  errorCode: null,
  nextRunAt: "2026-09-03T03:24:00+08:00",
};

const successfulDrill: PublicRecoveryDrill = {
  formatVersion: 1,
  drillId: "20260902T035000Z-abcdef1234567890",
  environment: "local",
  scope: "isolated-local",
  status: "verified",
  startedAt: "2026-09-02T03:50:00.000Z",
  completedAt: "2026-09-02T03:51:00.000Z",
  durationSeconds: 60,
  sourceArtifact: { name: successfulRun.backupName!, sha256: successfulRun.archiveSha256!, kind: "production-backup" },
  checks: { pgRestore: "passed", migrationLedger: "passed", securityCounts: "passed", masterKeyVolume: "passed", uploadsManifest: "passed", serviceHealth: "passed" },
  validationSha256: "b".repeat(64),
  migrationCount: 101,
  securityCounts: { users: 0, workspaces: 1, projects: 0, credentials: 0, projectAssets: 0 },
  errorCode: null,
};

function fakeSessionDb(user: Readonly<{ id: string; role: AppUserRole }>, bootstrapAdminId = initialAdminId): PrismaClient {
  const now = new Date();
  return {
    appUser: {
      findUnique: async () => ({
        id: user.id,
        disabledAt: null,
        accountAccessVersion: 1,
      }),
    },
    appSession: {
      findUnique: async () => ({
        id: "43a1baff-626a-4e3b-9c51-404ef8b19ed5",
        accountAccessVersion: 1,
        revokedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        lastSeenAt: now,
        user: {
          id: user.id,
          username: "operator",
          role: user.role,
          disabledAt: null,
          accountAccessVersion: 1,
        },
      }),
      updateMany: async () => ({ count: 0 }),
    },
    platformBootstrap: {
      findUnique: async () => ({ initialAdminUserId: bootstrapAdminId }),
    },
  } as unknown as PrismaClient;
}

function request(): Request {
  return new Request("http://127.0.0.1:3000/api/system/operations/backups", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
}

test("backup status reader accepts only bounded validated records and ignores malformed history", async (context) => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), "ai-project-os-ops-")), "backups");
  context.after(async () => rm(path.dirname(root), { force: true, recursive: true }));
  await mkdir(path.join(root, "history"), { recursive: true });
  await writeFile(path.join(root, "current.json"), JSON.stringify(successfulRun));
  await writeFile(path.join(root, "recovery-drill.json"), JSON.stringify(successfulDrill));
  await writeFile(path.join(root, "history", `${successfulRun.runId}.json`), JSON.stringify(successfulRun));
  await writeFile(path.join(root, "history", "20260901T032000Z-9999.json"), "not-json");
  await writeFile(path.join(root, "history", "unexpected.json"), JSON.stringify({ secret: "not-readable" }));

  const snapshot = await readBackupOperationsSnapshot({
    root,
    now: new Date("2026-09-02T04:00:00.000Z"),
  });

  assert.equal(snapshot.sourceStatus, "ready");
  assert.deepEqual(snapshot.current, successfulRun);
  assert.deepEqual(snapshot.history, [successfulRun]);
  assert.equal(snapshot.recoveryDrillSourceStatus, "ready");
  assert.deepEqual(snapshot.recoveryDrill, successfulDrill);
  assert.equal(snapshot.readAt, "2026-09-02T04:00:00.000Z");
});

test("backup status reader fails closed for missing, invalid, and symlinked status sources", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ai-project-os-ops-guard-"));
  context.after(async () => rm(temporaryRoot, { force: true, recursive: true }));

  const missing = await readBackupOperationsSnapshot({ root: path.join(temporaryRoot, "missing") });
  assert.equal(missing.sourceStatus, "not_configured");

  const realRoot = path.join(temporaryRoot, "real");
  const linkedRoot = path.join(temporaryRoot, "linked");
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot, "dir");
  const linked = await readBackupOperationsSnapshot({ root: linkedRoot });
  assert.equal(linked.sourceStatus, "invalid");

  await mkdir(path.join(realRoot, "history"));
  const outside = path.join(temporaryRoot, "outside.json");
  await writeFile(outside, JSON.stringify(successfulRun));
  await symlink(outside, path.join(realRoot, "current.json"));
  const symlinkedCurrent = await readBackupOperationsSnapshot({ root: realRoot });
  assert.equal(symlinkedCurrent.sourceStatus, "invalid");
  assert.equal(symlinkedCurrent.current, null);
});

test("recovery drill evidence is independent, strict, bounded, and fails closed", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ai-project-os-recovery-drill-"));
  context.after(async () => rm(temporaryRoot, { force: true, recursive: true }));
  await mkdir(path.join(temporaryRoot, "history"));
  await writeFile(path.join(temporaryRoot, "current.json"), JSON.stringify(successfulRun));

  const missing = await readBackupOperationsSnapshot({ root: temporaryRoot, now: new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(missing.recoveryDrillSourceStatus, "not_configured");
  assert.equal(missing.recoveryDrill, null);
  assert.equal(missing.current?.state, "succeeded");

  await writeFile(path.join(temporaryRoot, "recovery-drill.json"), JSON.stringify({ ...successfulDrill, errorCode: "DRILL_SHOULD_FAIL" }));
  const malformed = await readBackupOperationsSnapshot({ root: temporaryRoot, now: new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(malformed.recoveryDrillSourceStatus, "invalid");
  assert.equal(malformed.recoveryDrill, null);

  await writeFile(path.join(temporaryRoot, "recovery-drill.json"), JSON.stringify({
    ...successfulDrill,
    status: "failed",
    checks: { pgRestore: "failed", migrationLedger: "failed", securityCounts: "failed", masterKeyVolume: "failed", uploadsManifest: "failed", serviceHealth: "failed" },
    validationSha256: null,
    errorCode: "RECOVERY_DRILL_PRIMARY_FAILED",
    cleanupErrorCode: "RECOVERY_DRILL_CLEANUP_FAILED",
  }));
  const dualFailure = await readBackupOperationsSnapshot({ root: temporaryRoot, now: new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(dualFailure.recoveryDrillSourceStatus, "ready");
  assert.equal(dualFailure.recoveryDrill?.errorCode, "RECOVERY_DRILL_PRIMARY_FAILED");
  assert.equal(dualFailure.recoveryDrill?.cleanupErrorCode, "RECOVERY_DRILL_CLEANUP_FAILED");

  await writeFile(path.join(temporaryRoot, "recovery-drill.json"), JSON.stringify({ ...successfulDrill, completedAt: "2026-09-04T00:00:00.000Z" }));
  const future = await readBackupOperationsSnapshot({ root: temporaryRoot, now: new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(future.recoveryDrillSourceStatus, "invalid");
  assert.equal(future.recoveryDrill, null);

  const outside = path.join(temporaryRoot, "drill-outside.json");
  await writeFile(outside, JSON.stringify(successfulDrill));
  await rm(path.join(temporaryRoot, "recovery-drill.json"), { force: true });
  await symlink(outside, path.join(temporaryRoot, "recovery-drill.json"));
  const linked = await readBackupOperationsSnapshot({ root: temporaryRoot, now: new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(linked.recoveryDrillSourceStatus, "invalid");
  assert.equal(linked.recoveryDrill, null);
});

test("system backup API permits only the initial super administrator and never reads host status for denied users", async () => {
  const snapshot: BackupOperationsSnapshot = {
    sourceStatus: "ready",
    current: successfulRun,
    history: [successfulRun],
    recoveryDrillSourceStatus: "not_configured",
    recoveryDrill: null,
    schedule: { localTime: "03:20", randomizedDelayMinutes: 20, persistent: true },
    readAt: "2026-09-02T04:00:00.000Z",
  };
  let reads = 0;
  const readSnapshot = async () => {
    reads += 1;
    return snapshot;
  };

  const unauthenticatedResponse = await handleBackupOperationsGet(
    new Request("http://127.0.0.1:3000/api/system/operations/backups"),
    { db: fakeSessionDb({ id: otherAdminId, role: "user" }), readSnapshot },
  );
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(reads, 0);

  const memberResponse = await handleBackupOperationsGet(request(), {
    db: fakeSessionDb({ id: otherAdminId, role: "user" }),
    readSnapshot,
  });
  assert.equal(memberResponse.status, 403);
  assert.equal((await memberResponse.json() as { error: { code: string } }).error.code, "ACCESS_FORBIDDEN");
  assert.equal(reads, 0);

  const otherAdminResponse = await handleBackupOperationsGet(request(), {
    db: fakeSessionDb({ id: otherAdminId, role: "admin" }),
    readSnapshot,
  });
  assert.equal(otherAdminResponse.status, 403);
  assert.equal((await otherAdminResponse.json() as { error: { code: string } }).error.code, "AUTH_FORBIDDEN");
  assert.equal(reads, 0);

  const initialAdminResponse = await handleBackupOperationsGet(request(), {
    db: fakeSessionDb({ id: initialAdminId, role: "admin" }),
    readSnapshot,
  });
  assert.equal(initialAdminResponse.status, 200);
  assert.match(initialAdminResponse.headers.get("cache-control") ?? "", /no-store/u);
  assert.deepEqual(await initialAdminResponse.json(), snapshot);
  assert.equal(reads, 1);
});
