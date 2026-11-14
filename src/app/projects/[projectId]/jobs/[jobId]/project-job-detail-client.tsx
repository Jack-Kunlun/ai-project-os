"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { TokenUsageView } from "@/components/token-usage";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";
import { projectJobUnknownPresentation } from "@/lib/project-job-outcome-presentation";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { TokenUsageSummary } from "@/lib/token-usage";
import supportStyles from "../../project-support.module.css";
import { formatUiDateTimeOrFallback } from "@/lib/ui-date-format";

type JobStatus = "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
type Job = {
  id: string;
  projectId: string | null;
  kind: string;
  status: JobStatus;
  stage: string;
  result: unknown;
  progressCurrent: number;
  progressTotal: number;
  failureCode: string | null;
  usage?: TokenUsageSummary;
  reconciliationRequired: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    leasedAt: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    dispatchState: string;
    safeFailureCode: string | null;
    completedAt: string | null;
  }>;
};

type AutoExtractResult = Readonly<{
  sourceCount: number;
  candidateCount: number;
  returnedCandidateCount: number;
  duplicateCount: number;
  rejectedCandidateCount: number;
  recoveredExcerptCount: number;
  anchoredExcerptCount: number;
}>;

const kindLabels: Readonly<Record<string, string>> = {
  assetExtract: "图片或扫描件识别",
  githubScan: "GitHub 代码扫描",
  githubMaterialSync: "GitHub 资料同步",
  githubProjectSync: "GitHub 项目同步",
  gitRepositorySync: "代码仓库扫描",
  memoryIndex: "项目记忆索引",
  autoExtract: "项目资料自动抽取",
  semanticSearch: "项目记忆检索",
  ragAnswer: "引用式问答",
  projectBrief: "项目简报",
  projectAgent: "项目智能体调查",
};

const statusLabels: Readonly<Record<JobStatus, string>> = {
  queued: "等待执行",
  waitingConsent: "等待确认",
  running: "执行中",
  succeeded: "已完成",
  failed: "未完成",
  unknown: "结果未知",
  cancelled: "已取消",
};

function formatDate(value: string | null, language: "zh-CN" | "en", t: (text: string) => string): string {
  return formatUiDateTimeOrFallback(value ? new Date(value) : null, language, value ? t("时间无效") : "—");
}

function parentRoute(projectId: string, kind: string): string {
  if (["githubScan", "githubMaterialSync", "githubProjectSync", "gitRepositorySync"].includes(kind)) return `/projects/${projectId}/repositories`;
  if (kind === "assetExtract") return `/projects/${projectId}/assets`;
  if (["memoryIndex", "autoExtract", "semanticSearch", "ragAnswer"].includes(kind)) return `/projects/${projectId}/memory`;
  if (["projectBrief", "projectAgent"].includes(kind)) return `/projects/${projectId}/intelligence`;
  return `/projects/${projectId}/control`;
}

function parentSection(kind: string): "repositories" | "assets" | "memory" | "intelligence" | "control" {
  if (["githubScan", "githubMaterialSync", "githubProjectSync", "gitRepositorySync"].includes(kind)) return "repositories";
  if (kind === "assetExtract") return "assets";
  if (["memoryIndex", "autoExtract", "semanticSearch", "ragAnswer"].includes(kind)) return "memory";
  if (["projectBrief", "projectAgent"].includes(kind)) return "intelligence";
  return "control";
}

async function responseError(response: Response): Promise<string> {
  return (await safeResponseError(response, "任务详情加载失败")).message;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function notificationView(value: string | null): "all" | "unread" | "pending" | "system" {
  return value === "unread" || value === "pending" || value === "system" ? value : "all";
}

function notificationCursor(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9_-]{1,2048}$/u.test(value) ? value : null;
}

function notificationFocus(value: string | null): string | null {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

function autoExtractResult(value: unknown): AutoExtractResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { sourceCount: 0, candidateCount: 0, returnedCandidateCount: 0, duplicateCount: 0, rejectedCandidateCount: 0, recoveredExcerptCount: 0, anchoredExcerptCount: 0 };
  }
  const result = value as Record<string, unknown>;
  return {
    sourceCount: safeCount(result.sourceCount),
    candidateCount: safeCount(result.candidateCount),
    returnedCandidateCount: safeCount(result.returnedCandidateCount),
    duplicateCount: safeCount(result.duplicateCount),
    rejectedCandidateCount: safeCount(result.rejectedCandidateCount),
    recoveredExcerptCount: safeCount(result.recoveredExcerptCount),
    anchoredExcerptCount: safeCount(result.anchoredExcerptCount),
  };
}

function AutoExtractSummary({ projectId, result, successful }: { projectId: string; result: unknown; successful: boolean }) {
  const translateUi = useTranslate();
  const summary = autoExtractResult(result);
  const corrections = summary.recoveredExcerptCount + summary.anchoredExcerptCount;
  return <div className="mt-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><SummaryStat label={translateUi("处理资料")} value={summary.sourceCount} /><SummaryStat label={translateUi("新增候选")} value={summary.candidateCount} /><SummaryStat label={translateUi("重复 / 拒绝")} value={`${summary.duplicateCount} / ${summary.rejectedCandidateCount}`} /><SummaryStat label={translateUi("证据校正")} value={corrections} /></div><dl className="mt-4 grid gap-2 text-sm text-app-muted sm:grid-cols-3"><div className="rounded-panel bg-app-surface-soft px-4 py-3"><dt className="text-xs text-app-muted"><UiText text={"模型返回"} /></dt><dd className="mt-1 font-semibold text-app-text">{summary.returnedCandidateCount} {" "}<UiText text={"条"} /></dd></div><div className="rounded-panel bg-app-surface-soft px-4 py-3"><dt className="text-xs text-app-muted"><UiText text={"证据块定位"} /></dt><dd className="mt-1 font-semibold text-app-text">{summary.anchoredExcerptCount} {" "}<UiText text={"条"} /></dd></div><div className="rounded-panel bg-app-surface-soft px-4 py-3"><dt className="text-xs text-app-muted"><UiText text={"空白差异校正"} /></dt><dd className="mt-1 font-semibold text-app-text">{summary.recoveredExcerptCount} {" "}<UiText text={"条"} /></dd></div></dl>{successful && summary.candidateCount > 0 ? <Link href={`/projects/${projectId}/memory#auto-extract-review`} className="mt-5 inline-flex rounded-control px-4 py-3 text-sm font-semibold app-button-primary"><UiText text={"进入候选审核 →"} /></Link> : null}</div>;
}

function SummaryStat({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-panel border border-app-border bg-app-surface-soft px-4 py-4 app-panel"><p className="text-xs text-app-muted">{label}</p><p className="mt-2 text-xl font-semibold text-app-text">{value}</p></div>;
}

export function ProjectJobDetailClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const { projectId, jobId } = useParams<{ projectId: string; jobId: string }>();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("job", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const fromNotifications = navigation.from === "notifications";
  const safeReturnTo = navigation.returnTo;
  const notificationFilter = notificationView(searchParams.get("view"));
  const notificationPageCursor = notificationCursor(searchParams.get("cursor"));
  const notificationFocusId = notificationFocus(searchParams.get("focus"));
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const jobStatus = job?.status;
  const failure = projectJobFailurePresentation(job?.failureCode);
  const unknownOutcome = job ? projectJobUnknownPresentation(job) : null;

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { job: Job };
      setJob(payload.job);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [jobId, projectId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(initial);
  }, [reload]);

  useEffect(() => {
    if (jobStatus !== undefined && !["queued", "waitingConsent", "running"].includes(jobStatus)) return;
    const interval = window.setInterval(() => void reload(), 5_000);
    return () => window.clearInterval(interval);
  }, [jobStatus, reload]);

  const progress = job && job.progressTotal > 0 ? Math.min(100, Math.round(job.progressCurrent / job.progressTotal * 100)) : null;

  // Legacy governance links are accepted, but task detail always returns to
  // the overview task panel now that the top-level tab is gone.
  const governanceBackHref = navigation.from === "governance" || navigation.from === "overview" ? buildProjectHref(projectId, "overview", {
    status: navigation.status,
    kind: navigation.kind,
    search: navigation.search,
    cursor: navigation.cursor,
    focus: "task-runs",
    from: "overview",
    returnTo: safeReturnTo,
  }) : null;
  const backHref = governanceBackHref ?? safeReturnTo ?? (fromNotifications ? `/notifications?view=${notificationFilter}${notificationPageCursor ? `&cursor=${encodeURIComponent(notificationPageCursor)}` : ""}${notificationFocusId ? `&focus=${encodeURIComponent(notificationFocusId)}` : ""}` : job ? parentRoute(projectId, job.kind) : buildProjectHref(projectId, "overview", { focus: "task-runs", from: "overview" }));
  const projectSection = job ? parentSection(job.kind) : "overview";
  return <main className={supportStyles.supportPage}><AppHeader username={username} active="projects" projectId={projectId} projectSection={projectSection} isSystemAdmin={isSystemAdmin} /><div data-page-content className="mx-auto max-w-5xl px-6 py-10 sm:px-10"><nav className="page-back-nav" aria-label={translateUi("返回上一级")}><ParentPageLink href={backHref} label={governanceBackHref ? "返回任务列表" : fromNotifications ? "返回通知中心" : "返回上一级"} /></nav><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"Background task"} /></p><h1 className="app-page-title mt-3 font-semibold">{job ? translateUi(kindLabels[job.kind] ?? job.kind) : <UiText text={"任务详情"} />}</h1><p className="mt-3 font-mono text-xs text-app-muted [overflow-wrap:anywhere]">{jobId}</p></div></div>{error ? <p role="alert" className="mt-6 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /></p> : null}{loading && !job ? <div className="mt-8 h-56 animate-pulse rounded-control bg-app-surface-soft" /> : job ? <><section className="mt-8 overflow-hidden rounded-panel border border-app-border bg-app-surface app-panel"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-border p-6 sm:p-7"><div><p className="text-xs text-app-muted"><UiText text={"当前状态"} /></p><p className="mt-2 text-2xl font-semibold">{translateUi(unknownOutcome?.label ?? statusLabels[job.status])}</p><p className="mt-2 text-sm text-app-muted"><UiText text={"执行阶段："} />{translateUi(unknownOutcome?.stageLabel ?? job.stage)}</p></div><span className={`rounded-full px-4 py-2 text-xs font-semibold ${job.status === "succeeded" ? "bg-app-success-soft text-app-success-ink" : job.status === "failed" || unknownOutcome?.tone === "danger" ? "bg-app-danger-soft text-app-danger-ink" : job.status === "unknown" ? "bg-app-warning-soft text-app-warning-ink" : "bg-app-accent-soft text-app-link"}`}>{translateUi(unknownOutcome?.label ?? statusLabels[job.status])}</span></div>{progress !== null ? <div className="px-6 pt-6 sm:px-7"><div className="h-2 overflow-hidden rounded-full bg-app-surface-soft"><div className="h-full rounded-full bg-app-accent transition-all" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-xs text-app-muted">{job.progressCurrent} / {job.progressTotal} · {progress}%</p></div> : null}<dl className="grid gap-4 p-6 text-sm sm:grid-cols-3 sm:p-7"><div><dt className="text-xs text-app-muted"><UiText text={"创建时间"} /></dt><dd className="mt-1 font-medium text-app-text">{formatDate(job.createdAt, language, translateUi)}</dd></div><div><dt className="text-xs text-app-muted"><UiText text={"开始时间"} /></dt><dd className="mt-1 font-medium text-app-text">{formatDate(job.startedAt, language, translateUi)}</dd></div><div><dt className="text-xs text-app-muted"><UiText text={"结束时间"} /></dt><dd className="mt-1 font-medium text-app-text">{formatDate(job.completedAt, language, translateUi)}</dd></div></dl>{job.status === "failed" ? <div className="mx-6 mb-6 rounded-panel border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm leading-6 text-app-danger-ink sm:mx-7 sm:mb-7"><p className="font-semibold"><UiText text={"失败原因"} /></p><p className="mt-1">{translateUi(failure.summary)}</p><p className="mt-2"><span className="font-semibold"><UiText text={"处理建议："} /></span>{translateUi(failure.action)}</p>{failure.code ? <p className="mt-2 font-mono text-xs text-app-danger-ink [overflow-wrap:anywhere]"><UiText text={"错误代码："} />{failure.code}</p> : null}</div> : null}{unknownOutcome ? <div className={`mx-6 mb-6 rounded-panel border px-5 py-4 text-sm leading-6 sm:mx-7 sm:mb-7 ${unknownOutcome.tone === "danger" ? "border-app-danger-border bg-app-danger-soft text-app-danger-ink" : "border-app-warning-border bg-app-warning-soft text-app-warning-ink"}`}><p className="font-semibold">{translateUi(unknownOutcome.summary)}</p>{failure.code ? <p className="mt-2 font-mono text-xs [overflow-wrap:anywhere]"><UiText text={"错误代码："} />{failure.code}</p> : null}<p className="mt-2">{translateUi(unknownOutcome.recordNotice)}</p></div> : job.reconciliationRequired ? <p className="mx-6 mb-6 rounded-panel border border-app-warning-border bg-app-warning-soft px-5 py-4 text-sm text-app-warning-ink sm:mx-7 sm:mb-7"><UiText text={"外部调用记录仍需核对，请到项目概览的任务运行记录中处理；系统不会自动重试。"} /></p> : null}</section><TokenUsageView usage={job.usage} /><section className="mt-6 rounded-panel border border-app-border bg-app-surface p-6 sm:p-7 app-panel"><h2 className="text-lg font-semibold"><UiText text={"任务结果"} /></h2>{job.result === null ? <p className="mt-4 text-sm text-app-muted">{unknownOutcome ? translateUi(unknownOutcome.emptyResultText) : <UiText text={"该任务没有可公开展示的结果摘要。"} />}</p> : job.kind === "autoExtract" ? <AutoExtractSummary projectId={projectId} result={job.result} successful={job.status === "succeeded"} /> : <pre className="mt-4 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-panel bg-app-surface p-5 text-xs leading-6 text-app-muted">{JSON.stringify(job.result, null, 2)}</pre>}</section><section className="mt-6 rounded-panel border border-app-border bg-app-surface p-6 sm:p-7 app-panel"><h2 className="text-lg font-semibold"><UiText text={"执行记录"} /></h2>{job.attempts.length === 0 ? <p className="mt-4 text-sm text-app-muted"><UiText text={"尚无执行 attempt。"} /></p> : <div className="mt-4 divide-y divide-app-border">{job.attempts.map((attempt) => <article key={attempt.id} className="grid gap-3 py-4 text-xs sm:grid-cols-[auto_1fr_auto]"><span className="font-semibold text-app-text"><UiText text={"attempt #"} />{attempt.attemptNumber}</span><span className="text-app-muted">{formatDate(attempt.leasedAt, language, translateUi)} · {translateUi(attempt.dispatchState)}{attempt.safeFailureCode ? ` · ${attempt.safeFailureCode}` : ""}</span><span className="font-semibold text-app-muted">{attempt.status === "unknown" ? <UiText text={"调用结果未知"} /> : translateUi(attempt.status)}</span></article>)}</div>}</section></> : null}</div></main>;
}
