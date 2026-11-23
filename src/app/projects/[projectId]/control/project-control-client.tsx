"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ProjectIntelligenceParentLink } from "@/components/project-parent-link";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";
import { jobStatusLabels, type JobAttemptSummary } from "@/lib/workspace-summary";
import supportStyles from "../project-support.module.css";
import { formatUiDateTime } from "@/lib/ui-date-format";

type Job = {
  id: string;
  kind: "assetExtract" | "githubScan" | "githubMaterialSync" | "githubProjectSync" | "memoryIndex" | "autoExtract" | "semanticSearch" | "ragAnswer" | "projectBrief" | "projectAgent";
  status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  stage: string;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
  attempts: JobAttemptSummary[];
};

const jobKindLabels: Record<Job["kind"], string> = {
  assetExtract: "图片或扫描件识别",
  githubScan: "GitHub 代码扫描",
  githubMaterialSync: "GitHub 资料同步",
  githubProjectSync: "GitHub 项目同步",
  memoryIndex: "项目记忆索引",
  autoExtract: "项目资料自动抽取",
  semanticSearch: "项目记忆检索",
  ragAnswer: "引用式问答",
  projectBrief: "项目简报",
  projectAgent: "项目智能体调查",
};

type GitHubJobResult = {
  status?: string;
  warning?: string;
  warnings?: string[];
  syncRunId?: string;
  counts?: { added?: number; updated?: number; deleted?: number; unchanged?: number; withheld?: number };
  reconciliationRequired?: boolean;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { code?: unknown; message?: string } };
    const code = payload.error?.code;
    if (typeof code === "string" && /^(?:GIT|GITHUB|PROJECT_GITHUB_SYNC)_/u.test(code)) {
      const failure = projectJobFailurePresentation(code);
      if (failure.code) return `${failure.summary} ${failure.action}（错误代码：${failure.code}）`;
    }
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string, language: "zh-CN" | "en"): string {
  return formatUiDateTime(new Date(value), language, { dateStyle: "medium", timeStyle: "short" });
}

export function ProjectControlClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, jobResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store" }),
      ]);
      if (jobResponse.ok) {
        const jobPayload = await jobResponse.json() as { jobs: Job[] };
        setJobs(jobPayload.jobs);
        setJobsLoaded(true);
      }
      if (!projectResponse.ok || !jobResponse.ok) {
        const failed = [projectResponse, jobResponse].find((response) => !response.ok)!;
        throw new Error(await readError(failed, "控制台加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      setProjectName(projectPayload.project.name);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "控制台加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return (
    <main className={supportStyles.supportPage}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="control" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectIntelligenceParentLink projectId={projectId} /></div>
        <section className="app-page-intro"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-app-link"><UiText text={"Control plane"} /></p><h1 className="app-page-title mt-3 font-semibold">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-app-muted"><UiText text={"项目不再维护独立模型路由。普通用户使用平台默认免费模型；会员用户可在个人账号配置模型，并通过个人双确认委托在项目中使用。旧项目级 GitHub 连接和自动同步继续冻结；一次性手动只读委托已迁移到"} /><Link href={`/projects/${projectId}/repositories`} className="font-semibold text-app-link underline"><UiText text={"项目 Git 页面"} /></Link>。</p></section>
        {error ? <div role="alert" className="mb-6 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /></div> : null}
        {loading ? <div className="h-40 animate-pulse rounded-control bg-app-surface-soft" /> : (
          <>
            <ModelAccessSection />
            <FrozenRepositorySection projectId={projectId} />
            <JobSection projectId={projectId} jobs={jobs} jobsLoaded={jobsLoaded} onReload={reload} />
          </>
        )}
      </div>
    </main>
  );
}

function ModelAccessSection() {
  return <section className="rounded-panel border border-app-accent-border bg-app-accent-soft p-7 sm:p-8"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"Model access"} /></p><h2 className="mt-2 text-2xl font-semibold"><UiText text={"项目模型使用方式"} /></h2><p className="mt-3 max-w-3xl text-sm leading-7 text-app-muted"><UiText text={"项目内不再配置独立模型路由。普通用户使用管理员维护的平台默认免费托管模型；会员用户可在"} /><a href="/personal/models" className="font-semibold text-app-link underline"><UiText text={"个人模型设置"} /></a><UiText text={"中配置自己的模型，并在项目 AI 能力使用前完成个人连接所有者与项目 Owner 的双确认委托。"} /></p><p className="mt-4 rounded-panel bg-app-surface px-4 py-3 text-xs leading-5 text-app-muted"><UiText text={"当前页面只保留项目任务状态和 Git 委托入口。没有可用模型时，系统会返回明确的能力不可用状态，不会回退到已删除的项目路由。"} /></p></section>;
}

function FrozenRepositorySection({ projectId }: { projectId: string }) {
  return <section className="mt-8 rounded-panel border border-app-warning-border bg-app-warning-soft p-7 sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-warning-ink"><UiText text={"GitHub connector"} /></p>
    <h2 className="mt-2 text-2xl font-semibold text-app-text"><UiText text={"旧项目仓库自动化已冻结"} /></h2>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-app-warning-ink">
      <UiText text={"旧项目级 PAT 连接和历史 GitHub 外发仍冻结，当前页面不会接收或发送 PAT，也不会启动旧同步。手动只读读取和单独的自动读取授权请前往"} /><Link href={`/projects/${projectId}/repositories`} className="font-semibold underline"><UiText text={"项目 Git 委托"} /></Link><UiText text={"；自动读取须经连接所有者和项目 Owner 双确认。写入/提交和旧 PAT 路径保持关闭；运行结果以项目记录为准。"} /></p>
  </section>;
}


function JobSection({ projectId, jobs, jobsLoaded, onReload }: { projectId: string; jobs: Job[]; jobsLoaded: boolean; onReload: () => Promise<void> }) {
  const { language } = useAppearance();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, [jobs]);
  async function act(job: Job, action: "reconcile" | "cancel") {
    setPending(`${job.id}:${action}`); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/jobs/${job.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(await readError(response, "任务操作失败"));
      await onReload();
      setMessage(action === "cancel" ? "任务已取消。" : "任务已协调为未知结果，系统不会自动重试。重新运行需重新确认。");
    } catch (actionError) {
      setMessage(actionError instanceof Error ? actionError.message : "任务操作失败");
    } finally {
      setPending(null);
    }
  }
  return <section className="mt-8 rounded-panel border border-app-border bg-app-surface p-7 sm:p-8 app-panel"><div className="border-b border-app-border pb-5"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"Recoverable jobs"} /></p><h2 className="mt-2 text-2xl font-semibold"><UiText text={"最近任务"} /></h2><p className="mt-2 text-sm leading-6 text-app-muted"><UiText text={"每次执行都有独立租约与 attempt。未知结果不会自动重试，避免重复调用模型。"} /></p></div>{!jobsLoaded ? <p className="mt-6 text-sm text-app-muted"><UiText text={"项目任务暂不可用，请检查上方错误并重试。"} /></p> : jobs.length === 0 ? <p className="mt-6 text-sm text-app-muted"><UiText text={"还没有页面任务。"} /></p> : <div className="mt-5 divide-y divide-app-border">{jobs.map((job) => { const attempt = job.attempts[0]; const result = job.result as GitHubJobResult | null; const failure = projectJobFailurePresentation(job.failureCode); const expired = now !== null && job.status === "running" && attempt !== undefined && new Date(attempt.leaseExpiresAt).getTime() <= now; const canCancel = job.status === "queued" || job.status === "waitingConsent"; const canReconcile = expired || (job.kind === "githubProjectSync" && job.status === "unknown" && job.reconciliationRequired); return <div key={job.id} className="flex flex-wrap items-start justify-between gap-4 py-4"><div className="min-w-0"><p className="text-sm font-semibold text-app-text"><UiText text={jobKindLabels[job.kind]} /></p><p className="mt-1 text-xs text-app-muted">{formatDate(job.createdAt, language)} · {job.stage}{attempt ? ` · attempt #${attempt.attemptNumber}` : ""}</p>{job.kind === "githubProjectSync" && result?.syncRunId ? <p className="mt-2 text-xs text-app-muted"><UiText text={"变更：新增"} />{" "}{result.counts?.added ?? 0} {" "}<UiText text={"· 更新"} />{" "}{result.counts?.updated ?? 0} {" "}<UiText text={"· 删除"} />{" "}{result.counts?.deleted ?? 0} {" "}<UiText text={"· 保留"} />{" "}{result.counts?.withheld ?? 0} · <Link href={`/projects/${projectId}/github-syncs/${result.syncRunId}`} className="font-semibold text-app-link underline"><UiText text={"查看同步详情"} /></Link></p> : null}{job.kind === "githubProjectSync" && result?.warnings?.length ? <p className="mt-2 text-xs leading-5 text-app-warning-ink"><UiText text={"提示："} />{result.warnings.join(" · ")}</p> : null}{job.status === "failed" ? <p className="mt-2 text-xs leading-5 text-app-danger-ink"><UiText text={failure.summary} /> <UiText text={failure.action} /></p> : null}{job.status === "unknown" ? <p className="mt-2 text-xs leading-5 text-app-warning-ink">{job.kind === "githubProjectSync" && job.reconciliationRequired ? <UiText text={"外部读取结果未知；协调确认不会重试，也不会调用 GitHub，只记录放弃本次未知结果。"} /> : <UiText text={"外部调用结果未知，禁止自动重试；重新运行需重新确认。"} />}</p> : null}{expired ? <p className="mt-2 text-xs leading-5 text-app-warning-ink"><UiText text={"执行租约已过期，可手动协调确认。"} /></p> : null}</div><div className="flex flex-wrap items-center justify-end gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "succeeded" ? "bg-app-success-soft text-app-success-ink" : job.status === "failed" ? "bg-app-danger-soft text-app-danger-ink" : job.status === "unknown" ? "bg-app-warning-soft text-app-warning-ink" : job.status === "cancelled" ? "bg-app-surface-soft text-app-muted" : "bg-app-accent-soft text-app-link"}`}><UiText text={jobStatusLabels[job.status]} />{failure.code ? ` · ${failure.code}` : ""}</span>{canCancel ? <button type="button" onClick={() => void act(job, "cancel")} disabled={pending !== null} className="rounded-control border border-app-border px-3 py-1.5 text-xs font-semibold text-app-muted disabled:opacity-40">{pending === `${job.id}:cancel` ? <UiText text={"取消中…"} /> : <UiText text={"取消"} />}</button> : null}{canReconcile ? <button type="button" onClick={() => void act(job, "reconcile")} disabled={pending !== null} className="rounded-control border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 app-button-warning">{pending === `${job.id}:reconcile` ? <UiText text={"协调中…"} /> : job.kind === "githubProjectSync" && job.status === "unknown" ? <UiText text={"协调确认/关闭未知结果"} /> : <UiText text={"协调确认"} />}</button> : null}</div></div>; })}</div>}{message ? <p role="status" className="mt-4 rounded-field bg-app-surface-soft px-4 py-3 text-xs text-app-muted app-feedback-info"><UiFeedbackText text={message} /></p> : null}</section>;
}
