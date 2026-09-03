"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";

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
  unknown: "结果待确认",
  cancelled: "已取消",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "时间无效";
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
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "任务详情加载失败";
  } catch {
    return "任务详情加载失败";
  }
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  const summary = autoExtractResult(result);
  const corrections = summary.recoveredExcerptCount + summary.anchoredExcerptCount;
  return <div className="mt-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><SummaryStat label="处理资料" value={summary.sourceCount} /><SummaryStat label="新增候选" value={summary.candidateCount} /><SummaryStat label="重复 / 拒绝" value={`${summary.duplicateCount} / ${summary.rejectedCandidateCount}`} /><SummaryStat label="证据校正" value={corrections} /></div><dl className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 px-4 py-3"><dt className="text-xs text-slate-400">模型返回</dt><dd className="mt-1 font-semibold text-slate-700">{summary.returnedCandidateCount} 条</dd></div><div className="rounded-xl bg-slate-50 px-4 py-3"><dt className="text-xs text-slate-400">证据块定位</dt><dd className="mt-1 font-semibold text-slate-700">{summary.anchoredExcerptCount} 条</dd></div><div className="rounded-xl bg-slate-50 px-4 py-3"><dt className="text-xs text-slate-400">空白差异校正</dt><dd className="mt-1 font-semibold text-slate-700">{summary.recoveredExcerptCount} 条</dd></div></dl>{successful && summary.candidateCount > 0 ? <Link href={`/projects/${projectId}/memory#auto-extract-review`} className="mt-5 inline-flex rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500">进入候选审核 →</Link> : null}</div>;
}

function SummaryStat({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-xl font-semibold text-slate-900">{value}</p></div>;
}

export function ProjectJobDetailClient({ username }: { username: string }) {
  const { projectId, jobId } = useParams<{ projectId: string; jobId: string }>();
  const fromNotifications = useSearchParams().get("from") === "notifications";
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const jobStatus = job?.status;
  const failure = projectJobFailurePresentation(job?.failureCode);

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

  const backHref = fromNotifications ? "/notifications" : job ? parentRoute(projectId, job.kind) : `/projects/${projectId}/governance#task-runs`;
  const projectSection = job ? parentSection(job.kind) : "governance";
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="projects" projectId={projectId} projectSection={projectSection} /><div className="mx-auto max-w-5xl px-6 py-10 sm:px-10"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Background task</p><h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">{job ? kindLabels[job.kind] ?? job.kind : "任务详情"}</h1><p className="mt-3 font-mono text-xs text-slate-400 [overflow-wrap:anywhere]">{jobId}</p></div><Link href={backHref} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">← {fromNotifications ? "返回通知中心" : "返回上一级"}</Link></div>{error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}{loading && !job ? <div className="mt-8 h-56 animate-pulse rounded-3xl bg-slate-200" /> : job ? <><section className="mt-8 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-6 sm:p-7"><div><p className="text-xs text-slate-400">当前状态</p><p className="mt-2 text-2xl font-semibold">{statusLabels[job.status]}</p><p className="mt-2 text-sm text-slate-500">执行阶段：{job.stage}</p></div><span className={`rounded-full px-4 py-2 text-xs font-semibold ${job.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : job.status === "unknown" ? "bg-amber-50 text-amber-800" : "bg-indigo-50 text-indigo-700"}`}>{statusLabels[job.status]}</span></div>{progress !== null ? <div className="px-6 pt-6 sm:px-7"><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-xs text-slate-400">{job.progressCurrent} / {job.progressTotal} · {progress}%</p></div> : null}<dl className="grid gap-4 p-6 text-sm sm:grid-cols-3 sm:p-7"><div><dt className="text-xs text-slate-400">创建时间</dt><dd className="mt-1 font-medium text-slate-700">{formatDate(job.createdAt)}</dd></div><div><dt className="text-xs text-slate-400">开始时间</dt><dd className="mt-1 font-medium text-slate-700">{formatDate(job.startedAt)}</dd></div><div><dt className="text-xs text-slate-400">结束时间</dt><dd className="mt-1 font-medium text-slate-700">{formatDate(job.completedAt)}</dd></div></dl>{job.status === "failed" ? <div className="mx-6 mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-800 sm:mx-7 sm:mb-7"><p className="font-semibold">失败原因</p><p className="mt-1">{failure.summary}</p><p className="mt-2"><span className="font-semibold">处理建议：</span>{failure.action}</p>{failure.code ? <p className="mt-2 font-mono text-xs text-rose-600 [overflow-wrap:anywhere]">错误代码：{failure.code}</p> : null}</div> : null}{job.reconciliationRequired ? <p className="mx-6 mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 sm:mx-7 sm:mb-7">当前结果无法安全确认，需要到项目管理中人工收口；系统不会自动重试。</p> : null}</section><section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7"><h2 className="text-lg font-semibold">任务结果</h2>{job.result === null ? <p className="mt-4 text-sm text-slate-500">该任务没有可公开展示的结果摘要。</p> : job.kind === "autoExtract" ? <AutoExtractSummary projectId={projectId} result={job.result} successful={job.status === "succeeded"} /> : <pre className="mt-4 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-slate-950 p-5 text-xs leading-6 text-slate-200">{JSON.stringify(job.result, null, 2)}</pre>}</section><section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7"><h2 className="text-lg font-semibold">执行记录</h2>{job.attempts.length === 0 ? <p className="mt-4 text-sm text-slate-500">尚无执行 attempt。</p> : <div className="mt-4 divide-y divide-slate-100">{job.attempts.map((attempt) => <article key={attempt.id} className="grid gap-3 py-4 text-xs sm:grid-cols-[auto_1fr_auto]"><span className="font-semibold text-slate-700">attempt #{attempt.attemptNumber}</span><span className="text-slate-500">{formatDate(attempt.leasedAt)} · {attempt.dispatchState}{attempt.safeFailureCode ? ` · ${attempt.safeFailureCode}` : ""}</span><span className="font-semibold text-slate-500">{attempt.status}</span></article>)}</div>}</section></> : null}</div></main>;
}
