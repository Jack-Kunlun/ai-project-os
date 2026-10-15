export type ProjectOverviewMetricsInput = Readonly<{
  itemCounts: Readonly<{ candidate: number; confirmed: number }>;
  snapshotStale: boolean;
  governance: Readonly<{
    pendingReviews: Readonly<{ total: number }>;
    jobs: Readonly<{ reconciliationRequired: number; failed: number }>;
    github: Readonly<{ partial: number; rateLimited: number; unknown: number }>;
    index: Readonly<{ readiness: string }>;
  }>;
}>;

export type ProjectOverviewSummary = Readonly<{
  confirmed: number;
  candidates: number;
  snapshotStale: boolean;
  pendingContent: number;
  failedJobs: number;
  reconciliationRequired: number;
  taskIssues: number;
  githubPartial: number;
  githubRateLimited: number;
  githubUnknown: number;
  githubIssues: number;
  indexRisk: number;
  attentionTotal: number;
}>;

const readinessLabels: Readonly<Record<string, string>> = Object.freeze({
  routeMissing: "未配置向量路由",
  providerUnavailable: "向量供应商不可用",
  indexMissing: "尚未建立索引",
  legacyIndex: "旧版索引，需要升级",
  routeIncompatible: "向量路由已变化，需要重建",
  inputsChanged: "资料输入已变化，需要重建",
  ready: "索引可用",
});

const readinessDetails: Readonly<Record<string, string>> = Object.freeze({
  routeMissing: "尚未配置向量路由，因此当前没有可用的项目记忆索引。",
  providerUnavailable: "向量供应商不可用；语义查询暂不可用。",
  indexMissing: "尚未建立索引；这表示索引还不存在，不代表后台任务正在运行。",
  legacyIndex: "当前索引格式较旧，需要全量升级后才能恢复语义能力。",
  routeIncompatible: "当前向量路由与已有索引不兼容，需要重建索引。",
  inputsChanged: "项目资料已变化；重建索引后才能使用最新内容。",
  ready: "当前索引可用于语义检索。",
});

export function projectIndexReadinessLabel(readiness: string): string {
  return readinessLabels[readiness] ?? "索引状态未知";
}

export function projectIndexReadinessDetail(readiness: string): string {
  return readinessDetails[readiness] ?? "请打开项目记忆查看当前索引状态和处理建议。";
}

export function summarizeProjectOverview(input: ProjectOverviewMetricsInput): ProjectOverviewSummary {
  const pendingContent = Math.max(input.governance.pendingReviews.total, input.itemCounts.candidate);
  const failedJobs = input.governance.jobs.failed;
  const reconciliationRequired = input.governance.jobs.reconciliationRequired;
  const taskIssues = failedJobs + reconciliationRequired;
  const githubPartial = input.governance.github.partial;
  const githubRateLimited = input.governance.github.rateLimited;
  const githubUnknown = input.governance.github.unknown;
  const githubIssues = githubPartial + githubRateLimited + githubUnknown;
  const indexRisk = input.governance.index.readiness === "ready" ? 0 : 1;

  return Object.freeze({
    confirmed: input.itemCounts.confirmed,
    candidates: input.itemCounts.candidate,
    snapshotStale: input.snapshotStale,
    pendingContent,
    failedJobs,
    reconciliationRequired,
    taskIssues,
    githubPartial,
    githubRateLimited,
    githubUnknown,
    githubIssues,
    indexRisk,
    attentionTotal: pendingContent + taskIssues + githubIssues + indexRisk,
  });
}
