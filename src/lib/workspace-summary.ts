export type JobKind = "assetExtract" | "githubScan" | "githubMaterialSync" | "githubProjectSync" | "memoryIndex" | "autoExtract" | "semanticSearch" | "ragAnswer" | "projectBrief" | "projectAgent";
export type JobStatus = "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
export type JobAttemptStatus = "running" | "succeeded" | "failed" | "unknown" | "cancelled";
export type JobAttemptDispatchState = "pending" | "dispatched" | "acknowledged";
export type JobAttemptSummary = {
  id: string;
  attemptNumber: number;
  status: JobAttemptStatus;
  leasedAt: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  dispatchState: JobAttemptDispatchState;
  safeFailureCode: string | null;
  completedAt: string | null;
};

export const jobStatusLabels: Record<JobStatus, string> = {
  queued: "等待中",
  waitingConsent: "等待确认",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "未知结果",
  cancelled: "已取消",
};

export type WorkspaceProject = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    sources: number;
    assets: number;
    items: number;
    snapshots: number;
    repositoryLinks: number;
    webAiRoutes: number;
    projectAgentRuns: number;
  };
  memoryIndexPointer: { publishedAt: string } | null;
  backgroundJobs: Array<{
    id: string;
    kind: JobKind;
    status: JobStatus;
    stage: string;
    reconciliationRequired: boolean;
    createdAt: string;
    completedAt: string | null;
    attempts: JobAttemptSummary[];
  }>;
};

export type RecentJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: string;
  completedAt: string | null;
  attempts: JobAttemptSummary[];
  project: { id: string; name: string } | null;
};

export type DashboardPayload = {
  summary: {
    projects: number;
    confirmedItems: number;
    repositories: number;
    indexedProjects: number;
    routedProjects: number;
    activeJobs: number;
    assets: number;
    pendingAssetReviews: number;
    generationProviders: number;
    embeddingProviders: number;
  };
  projects: WorkspaceProject[];
  recentJobs: RecentJob[];
};
