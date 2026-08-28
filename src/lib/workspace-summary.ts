export type JobKind = "githubScan" | "githubMaterialSync" | "memoryIndex" | "autoExtract" | "semanticSearch" | "ragAnswer" | "projectBrief" | "projectAgent";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type WorkspaceProject = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    sources: number;
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
    createdAt: string;
    completedAt: string | null;
  }>;
};

export type RecentJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
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
    generationProviders: number;
    embeddingProviders: number;
  };
  projects: WorkspaceProject[];
  recentJobs: RecentJob[];
};
