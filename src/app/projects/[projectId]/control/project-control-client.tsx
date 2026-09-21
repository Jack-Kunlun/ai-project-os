"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ProjectIntelligenceParentLink } from "@/components/project-parent-link";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";
import { jobStatusLabels, type JobAttemptSummary } from "@/lib/workspace-summary";

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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectControlClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, jobResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !jobResponse.ok) {
        const failed = [projectResponse, jobResponse].find((response) => !response.ok)!;
        throw new Error(await readError(failed, "控制台加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const jobPayload = await jobResponse.json() as { jobs: Job[] };
      setProjectName(projectPayload.project.name);
      setJobs(jobPayload.jobs);
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
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="control" isSystemAdmin={isSystemAdmin} />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectIntelligenceParentLink projectId={projectId} /></div>
        <section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Control plane</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">项目不再维护独立模型路由。普通用户使用平台默认免费模型；会员用户可在个人账号配置模型，并通过个人双确认委托在项目中使用。旧项目级 GitHub 连接和自动同步继续冻结；一次性手动只读委托已迁移到<Link href={`/projects/${projectId}/repositories`} className="font-semibold text-indigo-700 underline">项目 Git 页面</Link>。</p></section>
        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {loading ? <div className="h-40 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <ModelAccessSection />
            <FrozenRepositorySection projectId={projectId} />
            <JobSection projectId={projectId} jobs={jobs} onReload={reload} />
          </>
        )}
      </div>
    </main>
  );
}

function ModelAccessSection() {
  return <section className="rounded-3xl border border-indigo-200 bg-indigo-50/70 p-7 shadow-sm sm:p-8"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Model access</p><h2 className="mt-2 text-2xl font-semibold">项目模型使用方式</h2><p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">项目内不再配置独立模型路由。普通用户使用管理员维护的平台默认免费托管模型；会员用户可在<a href="/personal/models" className="font-semibold text-indigo-700 underline">个人模型设置</a>中配置自己的模型，并在项目 AI 能力使用前完成个人连接所有者与项目 Owner 的双确认委托。</p><p className="mt-4 rounded-xl bg-white/80 px-4 py-3 text-xs leading-5 text-slate-600">当前页面只保留项目任务状态和 Git 委托入口。没有可用模型时，系统会返回明确的能力不可用状态，不会回退到已删除的项目路由。</p></section>;
}

function FrozenRepositorySection({ projectId }: { projectId: string }) {
  return <section className="mt-8 rounded-3xl border border-amber-200 bg-amber-50 p-7 shadow-sm sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">GitHub connector</p>
    <h2 className="mt-2 text-2xl font-semibold text-slate-950">旧项目仓库自动化已冻结</h2>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-amber-900">
      旧项目级 PAT 连接、自动同步和历史 GitHub 外发仍冻结，当前页面不会接收或发送 PAT，也不会启动仓库同步。一次性手动只读读取请前往<Link href={`/projects/${projectId}/repositories`} className="font-semibold underline">项目 Git 委托</Link>；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。
    </p>
  </section>;
}


function JobSection({ projectId, jobs, onReload }: { projectId: string; jobs: Job[]; onReload: () => Promise<void> }) {
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
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-5"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Recoverable jobs</p><h2 className="mt-2 text-2xl font-semibold">最近任务</h2><p className="mt-2 text-sm leading-6 text-slate-500">每次执行都有独立租约与 attempt。未知结果不会自动重试，避免重复调用模型。</p></div>{jobs.length === 0 ? <p className="mt-6 text-sm text-slate-500">还没有页面任务。</p> : <div className="mt-5 divide-y divide-slate-100">{jobs.map((job) => { const attempt = job.attempts[0]; const result = job.result as GitHubJobResult | null; const failure = projectJobFailurePresentation(job.failureCode); const expired = now !== null && job.status === "running" && attempt !== undefined && new Date(attempt.leaseExpiresAt).getTime() <= now; const canCancel = job.status === "queued" || job.status === "waitingConsent"; const canReconcile = expired || (job.kind === "githubProjectSync" && job.status === "unknown" && job.reconciliationRequired); return <div key={job.id} className="flex flex-wrap items-start justify-between gap-4 py-4"><div className="min-w-0"><p className="text-sm font-semibold text-slate-700">{job.kind}</p><p className="mt-1 text-xs text-slate-400">{formatDate(job.createdAt)} · {job.stage}{attempt ? ` · attempt #${attempt.attemptNumber}` : ""}</p>{job.kind === "githubProjectSync" && result?.syncRunId ? <p className="mt-2 text-xs text-slate-500">变更：新增 {result.counts?.added ?? 0} · 更新 {result.counts?.updated ?? 0} · 删除 {result.counts?.deleted ?? 0} · 保留 {result.counts?.withheld ?? 0} · <Link href={`/projects/${projectId}/github-syncs/${result.syncRunId}`} className="font-semibold text-indigo-700 underline">查看同步详情</Link></p> : null}{job.kind === "githubProjectSync" && result?.warnings?.length ? <p className="mt-2 text-xs leading-5 text-amber-700">提示：{result.warnings.join(" · ")}</p> : null}{job.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-700">{failure.summary} {failure.action}</p> : null}{job.status === "unknown" ? <p className="mt-2 text-xs leading-5 text-orange-700">{job.kind === "githubProjectSync" && job.reconciliationRequired ? "外部读取结果未知；协调确认不会重试，也不会调用 GitHub，只记录放弃本次未知结果。" : "外部调用结果未知，禁止自动重试；重新运行需重新确认。"}</p> : null}{expired ? <p className="mt-2 text-xs leading-5 text-amber-700">执行租约已过期，可手动协调确认。</p> : null}</div><div className="flex flex-wrap items-center justify-end gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : job.status === "unknown" ? "bg-orange-50 text-orange-700" : job.status === "cancelled" ? "bg-slate-100 text-slate-600" : "bg-indigo-50 text-indigo-700"}`}>{jobStatusLabels[job.status]}{failure.code ? ` · ${failure.code}` : ""}</span>{canCancel ? <button type="button" onClick={() => void act(job, "cancel")} disabled={pending !== null} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">{pending === `${job.id}:cancel` ? "取消中…" : "取消"}</button> : null}{canReconcile ? <button type="button" onClick={() => void act(job, "reconcile")} disabled={pending !== null} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40">{pending === `${job.id}:reconcile` ? "协调中…" : job.kind === "githubProjectSync" && job.status === "unknown" ? "协调确认/关闭未知结果" : "协调确认"}</button> : null}</div></div>; })}</div>}{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">{message}</p> : null}</section>;
}
