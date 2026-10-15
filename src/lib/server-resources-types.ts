export type ServerMetricStatus = "available" | "partial" | "unavailable";

export type ServerMemoryMetric = Readonly<{
  status: ServerMetricStatus;
  scope: "linux-kernel";
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
  unavailableReason: "NOT_LINUX" | "SOURCE_UNAVAILABLE" | "INVALID_SOURCE" | "OUT_OF_SAFE_RANGE" | null;
}>;

export type ApplicationProcessMemoryMetric = Readonly<{
  rssBytes: number | null;
}>;

export type ContainerMemoryMetric = Readonly<{
  status: "available" | "unavailable";
  currentBytes: number | null;
  limitBytes: number | null;
  usedPercent: number | null;
  unavailableReason: "NOT_DOCKER" | "CGROUP_MAPPING_UNCERTAIN" | "SOURCE_UNAVAILABLE" | "INVALID_SOURCE" | null;
}>;

export type ServerFilesystemMetric = Readonly<{
  scope: "deployment-directory-filesystem" | "uploads-directory-filesystem";
  label: string;
  status: ServerMetricStatus;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  reservedBytes: number | null;
  usedPercent: number | null;
  totalInodes: number | null;
  usedInodes: number | null;
  availableInodes: number | null;
  reservedInodes: number | null;
  inodeUsedPercent: number | null;
  unavailableReason: "SOURCE_UNAVAILABLE" | "INVALID_SOURCE" | "OUT_OF_SAFE_RANGE" | null;
}>;

export type ServerResourcesSnapshot = Readonly<{
  readAt: string;
  linuxMemory: ServerMemoryMetric;
  containerMemory: ContainerMemoryMetric;
  applicationProcess: ApplicationProcessMemoryMetric;
  filesystems: readonly [ServerFilesystemMetric, ServerFilesystemMetric];
  filesystemRelation: "same" | "different" | "unknown";
}>;
