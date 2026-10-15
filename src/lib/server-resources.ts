import { access, readFile, stat, statfs } from "node:fs/promises";
import type { BigIntStatsFs } from "node:fs";
import type {
  ContainerMemoryMetric,
  ServerFilesystemMetric,
  ServerMemoryMetric,
  ServerResourcesSnapshot,
} from "@/lib/server-resources-types";
import { assetStorageRoot } from "@/lib/project-assets/storage";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

type ResourceIo = Readonly<{
  platform: string;
  applicationRoot: string;
  uploadsRoot: string | null;
  isDockerEnvironment: () => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  statfs: (path: string) => Promise<BigIntStatsFs>;
  deviceId: (path: string) => Promise<bigint>;
  processRss: () => number;
  now: () => Date;
}>;

export type ServerResourcesCollectorOverrides = Partial<ResourceIo>;

function toSafeNumber(value: bigint): number | null {
  return value < BigInt(0) || value > MAX_SAFE_BIGINT ? null : Number(value);
}

function percent(used: number, available: number): number | null {
  const capacity = used + available;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) return null;
  return Math.round((used / capacity) * 1000) / 10;
}

function unavailableMemory(reason: ServerMemoryMetric["unavailableReason"]): ServerMemoryMetric {
  return {
    status: "unavailable",
    scope: "linux-kernel",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    usedPercent: null,
    unavailableReason: reason,
  };
}

export function parseLinuxMemoryInfo(content: string): ServerMemoryMetric {
  const values = new Map<string, bigint>();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(MemTotal|MemAvailable):\s*(\d+)\s+kB\s*$/u.exec(line);
    if (match) values.set(match[1], BigInt(match[2]));
  }

  const totalKb = values.get("MemTotal");
  const availableKb = values.get("MemAvailable");
  if (totalKb === undefined || availableKb === undefined || totalKb <= BigInt(0) || availableKb > totalKb) {
    return unavailableMemory("INVALID_SOURCE");
  }

  const total = toSafeNumber(totalKb * BigInt(1024));
  const available = toSafeNumber(availableKb * BigInt(1024));
  if (total === null || available === null) return unavailableMemory("OUT_OF_SAFE_RANGE");
  const used = total - available;
  return {
    status: "available",
    scope: "linux-kernel",
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    usedPercent: Math.round((used / total) * 1000) / 10,
    unavailableReason: null,
  };
}

function unavailableContainerMemory(reason: ContainerMemoryMetric["unavailableReason"]): ContainerMemoryMetric {
  return {
    status: "unavailable",
    currentBytes: null,
    limitBytes: null,
    usedPercent: null,
    unavailableReason: reason,
  };
}

async function readContainerMemory(io: ResourceIo): Promise<ContainerMemoryMetric> {
  let isDocker: boolean;
  try {
    isDocker = await io.isDockerEnvironment();
  } catch {
    return unavailableContainerMemory("SOURCE_UNAVAILABLE");
  }
  if (!isDocker) return unavailableContainerMemory("NOT_DOCKER");

  let cgroup: string;
  try {
    cgroup = await io.readFile("/proc/self/cgroup");
  } catch {
    return unavailableContainerMemory("SOURCE_UNAVAILABLE");
  }
  // Only the private cgroup namespace root has an unambiguous mapping to
  // /sys/fs/cgroup here. Other paths require mount-root resolution.
  if (!cgroup.split(/\r?\n/u).includes("0::/")) {
    return unavailableContainerMemory("CGROUP_MAPPING_UNCERTAIN");
  }

  try {
    const [currentText, limitText] = await Promise.all([
      io.readFile("/sys/fs/cgroup/memory.current"),
      io.readFile("/sys/fs/cgroup/memory.max"),
    ]);
    if (!/^\d+\s*$/u.test(currentText)) {
      return unavailableContainerMemory("INVALID_SOURCE");
    }
    const currentBig = BigInt(currentText.trim());
    const current = toSafeNumber(currentBig);
    if (current === null) {
      return unavailableContainerMemory("INVALID_SOURCE");
    }
    if (limitText.trim() === "max") {
      return {
        status: "available",
        currentBytes: current,
        limitBytes: null,
        usedPercent: null,
        unavailableReason: null,
      };
    }
    if (!/^\d+\s*$/u.test(limitText)) return unavailableContainerMemory("INVALID_SOURCE");
    const limit = toSafeNumber(BigInt(limitText.trim()));
    if (limit === null || limit <= 0 || current > limit) return unavailableContainerMemory("INVALID_SOURCE");
    return {
      status: "available",
      currentBytes: current,
      limitBytes: limit,
      usedPercent: Math.round((current / limit) * 1000) / 10,
      unavailableReason: null,
    };
  } catch {
    return unavailableContainerMemory("SOURCE_UNAVAILABLE");
  }
}

function unavailableFilesystem(
  scope: ServerFilesystemMetric["scope"],
  label: string,
  reason: ServerFilesystemMetric["unavailableReason"],
): ServerFilesystemMetric {
  return {
    scope,
    label,
    status: "unavailable",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    reservedBytes: null,
    usedPercent: null,
    totalInodes: null,
    usedInodes: null,
    availableInodes: null,
    reservedInodes: null,
    inodeUsedPercent: null,
    unavailableReason: reason,
  };
}

type DiskRead = Readonly<{
  metric: ServerFilesystemMetric;
  deviceId: bigint | null;
}>;

async function readFilesystem(
  path: string | null,
  scope: ServerFilesystemMetric["scope"],
  label: string,
  io: ResourceIo,
): Promise<DiskRead> {
  if (path === null) return { metric: unavailableFilesystem(scope, label, "SOURCE_UNAVAILABLE"), deviceId: null };

  const [filesystemResult, deviceResult] = await Promise.allSettled([io.statfs(path), io.deviceId(path)]);
  const deviceId = deviceResult.status === "fulfilled" ? deviceResult.value : null;
  if (filesystemResult.status === "rejected") {
    return { metric: unavailableFilesystem(scope, label, "SOURCE_UNAVAILABLE"), deviceId };
  }

  const fs = filesystemResult.value;
  if (
    fs.bsize <= BigInt(0) || fs.blocks < BigInt(0) || fs.bfree < BigInt(0) || fs.bavail < BigInt(0) ||
    fs.files < BigInt(0) || fs.ffree < BigInt(0) || fs.bfree > fs.blocks ||
    fs.bavail > fs.bfree || fs.files < fs.ffree
  ) {
    return { metric: unavailableFilesystem(scope, label, "INVALID_SOURCE"), deviceId };
  }

  const totalBig = fs.blocks * fs.bsize;
  const usedBig = (fs.blocks - fs.bfree) * fs.bsize;
  const availableBig = fs.bavail * fs.bsize;
  const reservedBig = totalBig - usedBig - availableBig;
  const inodeStatsSupported = fs.files > BigInt(0);
  const totalInodesBig = inodeStatsSupported ? fs.files : null;
  const availableInodesBig = inodeStatsSupported ? fs.ffree : null;
  const usedInodesBig = totalInodesBig === null || availableInodesBig === null ? null : totalInodesBig - availableInodesBig;
  const reservedInodesBig = totalInodesBig === null || usedInodesBig === null || availableInodesBig === null
    ? null
    : totalInodesBig - usedInodesBig - availableInodesBig;

  const totalBytes = toSafeNumber(totalBig);
  const usedBytes = toSafeNumber(usedBig);
  const availableBytes = toSafeNumber(availableBig);
  const reservedBytes = toSafeNumber(reservedBig);
  const totalInodes = totalInodesBig === null ? null : toSafeNumber(totalInodesBig);
  const usedInodes = usedInodesBig === null ? null : toSafeNumber(usedInodesBig);
  const availableInodes = availableInodesBig === null ? null : toSafeNumber(availableInodesBig);
  const reservedInodes = reservedInodesBig === null ? null : toSafeNumber(reservedInodesBig);
  const byteValuesAvailable = totalBytes !== null && usedBytes !== null && availableBytes !== null && reservedBytes !== null;
  const inodeValuesAvailable = totalInodes !== null && usedInodes !== null && availableInodes !== null && reservedInodes !== null;
  const status = byteValuesAvailable && inodeValuesAvailable ? "available" : byteValuesAvailable || inodeValuesAvailable ? "partial" : "unavailable";
  const bytesOutOfRange = totalBytes === null || usedBytes === null || availableBytes === null || reservedBytes === null;
  const inodesOutOfRange = inodeStatsSupported && (totalInodes === null || usedInodes === null || availableInodes === null || reservedInodes === null);

  return {
    deviceId,
    metric: {
      scope,
      label,
      status,
      totalBytes: byteValuesAvailable ? totalBytes : null,
      usedBytes: byteValuesAvailable ? usedBytes : null,
      availableBytes: byteValuesAvailable ? availableBytes : null,
      reservedBytes: byteValuesAvailable ? reservedBytes : null,
      usedPercent: byteValuesAvailable ? percent(usedBytes, availableBytes) : null,
      totalInodes: inodeValuesAvailable ? totalInodes : null,
      usedInodes: inodeValuesAvailable ? usedInodes : null,
      availableInodes: inodeValuesAvailable ? availableInodes : null,
      reservedInodes: inodeValuesAvailable ? reservedInodes : null,
      inodeUsedPercent: inodeValuesAvailable ? percent(usedInodes, availableInodes) : null,
      unavailableReason: status === "available" ? null : bytesOutOfRange || inodesOutOfRange
        ? "OUT_OF_SAFE_RANGE"
        : !inodeStatsSupported ? "SOURCE_UNAVAILABLE" : "INVALID_SOURCE",
    },
  };
}

function defaultIo(overrides: ServerResourcesCollectorOverrides): ResourceIo {
  return {
    platform: process.platform,
    applicationRoot: process.cwd(),
    uploadsRoot: (() => {
      try { return assetStorageRoot(); } catch { return null; }
    })(),
    isDockerEnvironment: async () => {
      try {
        await access("/.dockerenv");
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    readFile: async (path) => readFile(path, "utf8"),
    statfs: async (path) => statfs(path, { bigint: true }),
    deviceId: async (path) => (await stat(path, { bigint: true })).dev,
    processRss: () => process.memoryUsage().rss,
    now: () => new Date(),
    ...overrides,
  };
}

export async function readServerResourcesSnapshot(
  overrides: ServerResourcesCollectorOverrides = {},
): Promise<ServerResourcesSnapshot> {
  const io = defaultIo(overrides);
  const readAt = io.now().toISOString();
  const linuxMemoryPromise: Promise<ServerMemoryMetric> = io.platform !== "linux"
    ? Promise.resolve(unavailableMemory("NOT_LINUX"))
    : io.readFile("/proc/meminfo").then(parseLinuxMemoryInfo).catch(() => unavailableMemory("SOURCE_UNAVAILABLE"));
  const [linuxMemory, containerMemory, deployment, uploads] = await Promise.all([
    linuxMemoryPromise,
    readContainerMemory(io),
    readFilesystem(io.applicationRoot, "deployment-directory-filesystem", "应用部署目录所属文件系统", io),
    readFilesystem(io.uploadsRoot, "uploads-directory-filesystem", "上传存储目录所属文件系统", io),
  ]);

  let rssBytes: number | null = null;
  try {
    const rss = io.processRss();
    if (Number.isSafeInteger(rss) && rss >= 0) rssBytes = rss;
  } catch {
    // Process RSS is optional; other independently collected metrics remain useful.
  }

  const filesystemRelation = deployment.deviceId === null || uploads.deviceId === null
    ? "unknown"
    : deployment.deviceId === uploads.deviceId ? "same" : "different";

  return {
    readAt,
    linuxMemory,
    containerMemory,
    applicationProcess: { rssBytes },
    filesystems: [deployment.metric, uploads.metric],
    filesystemRelation,
  };
}
