import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { readBackupOperationsSnapshot } from "@/lib/system-operations";
import { handleBackupOperationsGet } from "@/lib/system-operations-route";
import type { BackupOperationsSnapshot, PublicBackupRun } from "@/lib/system-operations-types";

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

function fakeSessionDb(user: Readonly<{ id: string; role: AppUserRole }>, creatorId = initialAdminId): PrismaClient {
  const now = new Date();
  return {
    appSession: {
      findUnique: async () => ({
        id: "43a1baff-626a-4e3b-9c51-404ef8b19ed5",
        revokedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        lastSeenAt: now,
        user: {
          id: user.id,
          username: "operator",
          role: user.role,
          disabledAt: null,
        },
      }),
      updateMany: async () => ({ count: 0 }),
    },
    workspace: {
      findUnique: async () => ({ createdById: creatorId }),
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

test("system backup API permits only the initial super administrator and never reads host status for denied users", async () => {
  const snapshot: BackupOperationsSnapshot = {
    sourceStatus: "ready",
    current: successfulRun,
    history: [successfulRun],
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
    { db: fakeSessionDb({ id: otherAdminId, role: "member" }), readSnapshot },
  );
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(reads, 0);

  const memberResponse = await handleBackupOperationsGet(request(), {
    db: fakeSessionDb({ id: otherAdminId, role: "member" }),
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
