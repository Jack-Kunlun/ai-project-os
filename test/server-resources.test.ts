import assert from "node:assert/strict";
import test from "node:test";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import type { BigIntStatsFs } from "node:fs";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { parseLinuxMemoryInfo, readServerResourcesSnapshot } from "@/lib/server-resources";
import { handleServerResourcesGet } from "@/lib/server-resources-route";
import type { ServerResourcesSnapshot } from "@/lib/server-resources-types";

const initialAdminId = "d348244a-24b9-4893-9afb-164f3618d93e";
const otherUserId = "b04f05ab-5567-4e9c-b0cd-5d9e0c3e5608";
const sessionToken = "a".repeat(48);

function fakeSessionDb(user: Readonly<{ id: string; role: AppUserRole }>, bootstrapAdminId = initialAdminId): PrismaClient {
  const now = new Date();
  return {
    appUser: {
      findUnique: async () => ({ id: user.id, disabledAt: null, accountAccessVersion: 1, securityRevision: 1 }),
    },
    appSession: {
      findUnique: async () => ({
        id: "43a1baff-626a-4e3b-9c51-404ef8b19ed5",
        accountAccessVersion: 1,
        securityRevision: 1,
        revokedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        lastSeenAt: now,
        user: {
          id: user.id,
          username: "operator",
          role: user.role,
          disabledAt: null,
          accountAccessVersion: 1,
          securityRevision: 1,
        },
      }),
      updateMany: async () => ({ count: 0 }),
    },
    platformBootstrap: {
      findUnique: async () => ({ initialAdminUserId: bootstrapAdminId }),
    },
  } as unknown as PrismaClient;
}

function authenticatedRequest(): Request {
  return new Request("http://127.0.0.1:3000/api/system/operations/resources", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
}

function stats(overrides: Partial<BigIntStatsFs> = {}): BigIntStatsFs {
  return {
    type: BigInt(1),
    bsize: BigInt(4096),
    blocks: BigInt(1000),
    bfree: BigInt(300),
    bavail: BigInt(250),
    files: BigInt(1000),
    ffree: BigInt(0),
    ...overrides,
  };
}

async function containerMetric(options: Readonly<{
  docker: boolean;
  cgroup?: string;
  current?: string | null;
  limit?: string | null;
}>): Promise<Readonly<{ metric: ServerResourcesSnapshot["containerMemory"]; readPaths: string[] }>> {
  const readPaths: string[] = [];
  const snapshot = await readServerResourcesSnapshot({
    platform: "darwin",
    applicationRoot: "/service",
    uploadsRoot: null,
    isDockerEnvironment: async () => options.docker,
    readFile: async (path) => {
      readPaths.push(path);
      if (path === "/proc/self/cgroup") return options.cgroup ?? "0::/\n";
      if (path === "/sys/fs/cgroup/memory.current" && options.current !== null) return options.current ?? "450";
      if (path === "/sys/fs/cgroup/memory.max" && options.limit !== null) return options.limit ?? "1000";
      throw new Error("source unavailable");
    },
    statfs: async () => stats(),
    deviceId: async () => BigInt(17),
    processRss: () => 1,
  });
  return { metric: snapshot.containerMemory, readPaths };
}

test("Linux memory uses MemAvailable instead of MemFree to avoid cache-driven false alarms", () => {
  const metric = parseLinuxMemoryInfo([
    "MemTotal:       16777216 kB",
    "MemFree:          100000 kB",
    "MemAvailable:  13421772 kB",
    "Buffers:           10000 kB",
  ].join("\n"));

  assert.equal(metric.status, "available");
  assert.equal(metric.totalBytes, 16 * 1024 ** 3);
  assert.equal(metric.availableBytes, 13_421_772 * 1024);
  assert.ok(metric.usedPercent !== null && metric.usedPercent > 19 && metric.usedPercent < 21);
  assert.ok((metric.usedBytes ?? 0) < 4 * 1024 ** 3);
});

test("missing or invalid Linux memory fields stay unavailable rather than becoming zero", () => {
  assert.deepEqual(parseLinuxMemoryInfo("MemTotal: 100 kB\nMemFree: 100 kB"), {
    status: "unavailable",
    scope: "linux-kernel",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    usedPercent: null,
    unavailableReason: "INVALID_SOURCE",
  });
  assert.equal(parseLinuxMemoryInfo("MemTotal: 100 kB\nMemAvailable: 101 kB").status, "unavailable");
});

test("filesystem snapshot uses df-compatible reserved space and keeps same-filesystem capacity distinct", async () => {
  const snapshot = await readServerResourcesSnapshot({
    platform: "darwin",
    applicationRoot: "/service",
    uploadsRoot: "/uploads",
    statfs: async () => stats(),
    deviceId: async () => BigInt(17),
    processRss: () => 12_345,
    now: () => new Date("2026-10-15T03:00:00.000Z"),
  });

  assert.equal(snapshot.filesystemRelation, "same");
  assert.equal(snapshot.readAt, "2026-10-15T03:00:00.000Z");
  assert.equal(snapshot.applicationProcess.rssBytes, 12_345);
  assert.deepEqual(
    [snapshot.filesystems[0].totalBytes, snapshot.filesystems[0].usedBytes, snapshot.filesystems[0].availableBytes],
    [snapshot.filesystems[1].totalBytes, snapshot.filesystems[1].usedBytes, snapshot.filesystems[1].availableBytes],
  );
  assert.equal(snapshot.filesystems[0].totalBytes, 4_096_000);
  assert.equal(snapshot.filesystems[0].usedBytes, 2_867_200);
  assert.equal(snapshot.filesystems[0].availableBytes, 1_024_000);
  assert.equal(snapshot.filesystems[0].reservedBytes, 204_800);
  assert.ok(Math.abs((snapshot.filesystems[0].usedPercent ?? 0) - 73.7) < 0.1);
  assert.equal(snapshot.filesystems[0].totalInodes, 1000);
  assert.equal(snapshot.filesystems[0].usedInodes, 1000);
  assert.equal(snapshot.filesystems[0].availableInodes, 0);
  assert.equal(snapshot.filesystems[0].reservedInodes, 0);
  assert.equal(snapshot.filesystems[0].inodeUsedPercent, 100);
});

test("unsupported inode stats and out-of-safe-range bytes never produce NaN or rounded large values", async () => {
  const zeroInodeSnapshot = await readServerResourcesSnapshot({
    platform: "darwin",
    applicationRoot: "/service",
    uploadsRoot: "/uploads",
    statfs: async () => stats({ blocks: BigInt(0), bfree: BigInt(0), bavail: BigInt(0), files: BigInt(0), ffree: BigInt(0) }),
    deviceId: async (path) => path === "/service" ? BigInt(17) : BigInt(18),
    processRss: () => 1,
  });
  assert.equal(zeroInodeSnapshot.filesystems[0].status, "partial");
  assert.equal(zeroInodeSnapshot.filesystems[0].totalInodes, null);
  assert.equal(zeroInodeSnapshot.filesystems[0].availableInodes, null);
  assert.equal(zeroInodeSnapshot.filesystems[0].inodeUsedPercent, null);
  assert.equal(zeroInodeSnapshot.filesystemRelation, "different");

  const largeSnapshot = await readServerResourcesSnapshot({
    platform: "darwin",
    applicationRoot: "/service",
    uploadsRoot: null,
    statfs: async () => stats({ bsize: BigInt(1), blocks: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), bfree: BigInt(1), bavail: BigInt(1) }),
    deviceId: async () => BigInt(17),
    processRss: () => 1,
  });
  assert.equal(largeSnapshot.filesystems[0].status, "partial");
  assert.equal(largeSnapshot.filesystems[0].totalBytes, null);
  assert.equal(largeSnapshot.filesystems[0].usedBytes, null);
  assert.equal(largeSnapshot.filesystems[0].availableBytes, null);
  assert.equal(largeSnapshot.filesystems[0].unavailableReason, "OUT_OF_SAFE_RANGE");
  assert.equal(largeSnapshot.filesystems[0].totalInodes, 1000);
  assert.equal(largeSnapshot.filesystems[1].status, "unavailable");
});

test("cgroup v2 finite memory limit is read when Docker and the namespace root are verified", async () => {
  const { metric, readPaths } = await containerMetric({ docker: true, cgroup: "0::/\n", current: "450", limit: "1000" });
  assert.deepEqual(metric, {
    status: "available",
    currentBytes: 450,
    limitBytes: 1000,
    usedPercent: 45,
    unavailableReason: null,
  });
  assert.ok(readPaths.includes("/proc/self/cgroup"));
  assert.ok(readPaths.includes("/sys/fs/cgroup/memory.current"));
  assert.ok(readPaths.includes("/sys/fs/cgroup/memory.max"));
});

test("injected Docker detection skips cgroup reads outside a container", async () => {
  const { metric, readPaths } = await containerMetric({ docker: false });
  assert.equal(metric.status, "unavailable");
  assert.equal(metric.unavailableReason, "NOT_DOCKER");
  assert.deepEqual(readPaths, []);
});

test("cgroup v2 max keeps current usage available without inventing a limit or percentage", async () => {
  const { metric } = await containerMetric({ docker: true, current: "4096", limit: "max" });
  assert.deepEqual(metric, {
    status: "available",
    currentBytes: 4096,
    limitBytes: null,
    usedPercent: null,
    unavailableReason: null,
  });
});

test("cgroup v2 collection rejects uncertain mappings and reports unreadable sources as unavailable", async () => {
  const uncertain = await containerMetric({ docker: true, cgroup: "0::/tenant/app\n", current: "450", limit: "1000" });
  assert.equal(uncertain.metric.status, "unavailable");
  assert.equal(uncertain.metric.unavailableReason, "CGROUP_MAPPING_UNCERTAIN");
  assert.ok(!uncertain.readPaths.some((path) => path.startsWith("/sys/fs/cgroup/")));

  const unreadable = await containerMetric({ docker: true, current: null, limit: "1000" });
  assert.equal(unreadable.metric.status, "unavailable");
  assert.equal(unreadable.metric.currentBytes, null);
  assert.equal(unreadable.metric.unavailableReason, "SOURCE_UNAVAILABLE");
});

test("resources API authenticates before collecting and is available only to the initial super administrator", async () => {
  const snapshot: ServerResourcesSnapshot = {
    readAt: "2026-10-15T03:00:00.000Z",
    linuxMemory: parseLinuxMemoryInfo("MemTotal: 100 kB\nMemAvailable: 80 kB"),
    containerMemory: { status: "unavailable", currentBytes: null, limitBytes: null, usedPercent: null, unavailableReason: "NOT_DOCKER" },
    applicationProcess: { rssBytes: 1024 },
    filesystems: [
      { scope: "deployment-directory-filesystem", label: "应用部署目录所属文件系统", status: "unavailable", totalBytes: null, usedBytes: null, availableBytes: null, reservedBytes: null, usedPercent: null, totalInodes: null, usedInodes: null, availableInodes: null, reservedInodes: null, inodeUsedPercent: null, unavailableReason: "SOURCE_UNAVAILABLE" },
      { scope: "uploads-directory-filesystem", label: "上传存储目录所属文件系统", status: "unavailable", totalBytes: null, usedBytes: null, availableBytes: null, reservedBytes: null, usedPercent: null, totalInodes: null, usedInodes: null, availableInodes: null, reservedInodes: null, inodeUsedPercent: null, unavailableReason: "SOURCE_UNAVAILABLE" },
    ],
    filesystemRelation: "unknown",
  };
  let reads = 0;
  const readSnapshot = async () => {
    reads += 1;
    return snapshot;
  };

  const anonymous = await handleServerResourcesGet(
    new Request("http://127.0.0.1:3000/api/system/operations/resources"),
    { db: fakeSessionDb({ id: otherUserId, role: "user" }), readSnapshot },
  );
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
  assert.equal(reads, 0);

  for (const user of [
    { id: otherUserId, role: "user" as const },
    { id: otherUserId, role: "admin" as const },
  ]) {
    const denied = await handleServerResourcesGet(authenticatedRequest(), {
      db: fakeSessionDb(user),
      readSnapshot,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("cache-control"), "private, no-store");
    assert.equal(reads, 0);
  }

  const allowed = await handleServerResourcesGet(authenticatedRequest(), {
    db: fakeSessionDb({ id: initialAdminId, role: "admin" }),
    readSnapshot,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await allowed.json(), snapshot);
  assert.equal(reads, 1);
});
