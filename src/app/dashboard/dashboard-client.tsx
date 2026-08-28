"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { jobStatusLabels, type DashboardPayload, type JobKind, type JobStatus, type RecentJob } from "@/lib/workspace-summary";

const emptyPayload: DashboardPayload = {
  summary: {
    projects: 0,
    confirmedItems: 0,
    repositories: 0,
    indexedProjects: 0,
    routedProjects: 0,
    activeJobs: 0,
    generationProviders: 0,
    embeddingProviders: 0,
  },
  projects: [],
  recentJobs: [],
};

const jobLabels: Record<JobKind, string> = {
  githubScan: "代码扫描",
  githubMaterialSync: "仓库资料同步",
  githubProjectSync: "GitHub 全量同步",
  memoryIndex: "记忆索引",
  autoExtract: "自动抽取",
  semanticSearch: "语义检索",
  ragAnswer: "引用式问答",
  projectBrief: "项目简报",
  projectAgent: "智能体调查",
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function jobHref(job: Pick<RecentJob, "kind" | "project">): string {
  if (!job.project) return "/dashboard";
  if (job.kind === "githubScan" || job.kind === "githubMaterialSync" || job.kind === "githubProjectSync") return `/projects/${job.project.id}/control`;
  if (job.kind === "projectBrief" || job.kind === "projectAgent") return `/projects/${job.project.id}/intelligence`;
  return `/projects/${job.project.id}/memory`;
}

export function DashboardClient({ username }: { username: string }) {
  const [payload, setPayload] = useState<DashboardPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Dashboard 加载失败"));
      setPayload(await response.json() as DashboardPayload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Dashboard 加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const nextStep = useMemo(() => {
    const { summary, projects } = payload;
    if (summary.generationProviders === 0 || summary.embeddingProviders === 0) {
      return { label: "先配置可用的生成与向量模型", detail: "完成连接测试后，项目才能建立记忆并运行智能体。", href: "/settings", action: "配置模型" };
    }
    if (summary.projects === 0) {
      return { label: "创建第一个项目", detail: "项目会隔离资料、仓库、记忆和智能分析记录。", href: "/projects", action: "前往项目" };
    }
    const unrouted = projects.find((project) => project._count.webAiRoutes < 3);
    if (unrouted) {
      return { label: `完成「${unrouted.name}」的 AI 路由`, detail: "分别选择语义向量、自动抽取和引用式问答供应商。", href: `/projects/${unrouted.id}/control`, action: "继续配置" };
    }
    const unindexed = projects.find((project) => project.memoryIndexPointer === null);
    if (unindexed) {
      return { label: `为「${unindexed.name}」建立智能记忆`, detail: "先准备资料，再生成可用于检索和问答的语义索引。", href: `/projects/${unindexed.id}/memory`, action: "建立索引" };
    }
    const current = projects[0]!;
    return { label: "项目智能能力已经就绪", detail: "可以生成状态简报，或针对当前项目开展一次只读调查。", href: `/projects/${current.id}/intelligence`, action: "进入项目智能体" };
  }, [payload]);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="dashboard" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        <section className="relative overflow-hidden rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10 lg:px-12">
          <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-indigo-500/30 blur-3xl" />
          <div className="absolute bottom-0 right-1/3 h-28 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="relative grid gap-8 lg:grid-cols-[1.25fr_0.75fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Your project command center</p>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">欢迎回来，{username}</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">从这里查看跨项目状态、判断工作空间是否就绪，并继续最近的同步、记忆或智能分析任务。</p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link href="/projects" className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50">进入项目</Link>
                <Link href="/guide#dashboard" className="rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/15">查看使用指南</Link>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.07] p-5 backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-200">推荐下一步</p>
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,.8)]" />
              </div>
              <h2 className="mt-4 text-xl font-semibold">{nextStep.label}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">{nextStep.detail}</p>
              <Link href={nextStep.href} className="mt-5 inline-flex text-sm font-semibold text-indigo-200 hover:text-white">{nextStep.action} →</Link>
            </div>
          </div>
        </section>

        {error ? <div className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold underline underline-offset-4">重试</button></div> : null}

        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="项目概览指标">
          <MetricCard label="项目" value={payload.summary.projects} detail="统一工作空间" icon="folder" tone="indigo" loading={loading} />
          <MetricCard label="已确认事实" value={payload.summary.confirmedItems} detail="经过人工审核" icon="check" tone="emerald" loading={loading} />
          <MetricCard label="连接仓库" value={payload.summary.repositories} detail="多仓库只读来源" icon="branch" tone="cyan" loading={loading} />
          <MetricCard label="智能记忆" value={`${payload.summary.indexedProjects}/${payload.summary.projects}`} detail={payload.summary.activeJobs > 0 ? `${payload.summary.activeJobs} 个任务进行中` : payload.summary.indexedProjects > 0 ? `${payload.summary.indexedProjects} 个项目已建立索引` : "尚未建立活动索引"} icon="spark" tone="violet" loading={loading} />
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[0.82fr_1.18fr]">
          <ReadinessPanel payload={payload} loading={loading} />
          <RecentJobs jobs={payload.recentJobs} loading={loading} />
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, detail, icon, tone, loading }: { label: string; value: string | number; detail: string; icon: string; tone: "indigo" | "emerald" | "cyan" | "violet"; loading: boolean }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600",
    emerald: "bg-emerald-50 text-emerald-600",
    cyan: "bg-cyan-50 text-cyan-600",
    violet: "bg-violet-50 text-violet-600",
  } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold text-slate-500">{label}</p>{loading ? <div className="mt-3 h-8 w-16 animate-pulse rounded bg-slate-100" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}</div><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><DashboardIcon name={icon} /></span></div><p className="mt-4 text-xs text-slate-400">{detail}</p></article>;
}

function ReadinessPanel({ payload, loading }: { payload: DashboardPayload; loading: boolean }) {
  const steps = [
    { label: "模型连接", detail: "生成与向量能力", done: payload.summary.generationProviders > 0 && payload.summary.embeddingProviders > 0, href: "/settings" },
    { label: "项目空间", detail: "至少创建一个项目", done: payload.summary.projects > 0, href: "/projects" },
    { label: "能力路由", detail: `${payload.summary.routedProjects}/${payload.summary.projects} 个项目完成`, done: payload.summary.projects > 0 && payload.summary.routedProjects === payload.summary.projects, href: payload.projects[0] ? `/projects/${payload.projects[0].id}/control` : "/projects" },
    { label: "智能记忆", detail: `${payload.summary.indexedProjects}/${payload.summary.projects} 个项目有索引`, done: payload.summary.projects > 0 && payload.summary.indexedProjects === payload.summary.projects, href: payload.projects[0] ? `/projects/${payload.projects[0].id}/memory` : "/projects" },
  ];
  const completed = steps.filter((step) => step.done).length;
  return <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Setup progress</p><h2 className="mt-2 text-xl font-semibold">工作空间就绪度</h2></div><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">{loading ? "…" : `${completed}/4`}</span></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all" style={{ width: `${completed * 25}%` }} /></div><div className="mt-5 space-y-2">{steps.map((step, index) => <Link key={step.label} href={step.href} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-slate-50"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${step.done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>{step.done ? "✓" : index + 1}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-700">{step.label}</span><span className="block truncate text-xs text-slate-400">{step.detail}</span></span><span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">→</span></Link>)}</div></section>;
}

function RecentJobs({ jobs, loading }: { jobs: RecentJob[]; loading: boolean }) {
  return <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Recent activity</p><h2 className="mt-2 text-xl font-semibold">最近任务</h2></div><span className="text-xs text-slate-400">自动保留执行状态</span></div>{loading ? <div className="mt-5 space-y-3">{[1, 2, 3].map((item) => <div key={item} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}</div> : jobs.length === 0 ? <div className="mt-5 rounded-2xl bg-slate-50 px-5 py-9 text-center text-sm text-slate-500">运行仓库同步、索引或智能分析后，任务会显示在这里。</div> : <div className="mt-5 divide-y divide-slate-100">{jobs.slice(0, 5).map((job) => <Link key={job.id} href={jobHref(job)} className="flex items-center gap-3 py-3.5 first:pt-0 last:pb-0"><StatusDot status={job.status} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{jobLabels[job.kind]}</span><span className="block truncate text-xs text-slate-400">{job.project?.name ?? "系统任务"} · {formatDate(job.createdAt)}</span></span><span className="shrink-0 text-xs font-medium text-slate-500">{jobStatusLabels[job.status]}</span></Link>)}</div>}</section>;
}

function StatusDot({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = { queued: "bg-amber-400", waitingConsent: "bg-amber-400", running: "animate-pulse bg-indigo-500", succeeded: "bg-emerald-500", failed: "bg-rose-500", unknown: "bg-orange-500", cancelled: "bg-slate-400" };
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${styles[status]}`} />;
}

function DashboardIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    folder: <path d="M3 7.5h7l2-2h9v12.75A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25V7.5Z" />,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16.5 9" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 9c5 0 4-2 8-2" /></>,
    spark: <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Zm6 12 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
