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
    assets: 0,
    pendingAssetReviews: 0,
    atRiskProjects: 0,
    overdueWorkItems: 0,
    blockedWorkItems: 0,
    pendingRecommendations: 0,
    openImpactSuggestions: 0,
    pendingActionApprovals: 0,
    atRiskWorlds: 0,
    attentionWorlds: 0,
    insufficientDataWorlds: 0,
  },
  projects: [],
  recentJobs: [],
  operations: [],
  worlds: [],
};

const jobLabels: Record<JobKind, string> = {
  assetExtract: "文件图片识别",
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
  if (job.kind === "assetExtract") return `/projects/${job.project.id}/assets`;
  if (job.kind === "githubScan" || job.kind === "githubMaterialSync" || job.kind === "githubProjectSync") return `/projects/${job.project.id}/control`;
  if (job.kind === "projectBrief" || job.kind === "projectAgent") return `/projects/${job.project.id}/intelligence`;
  return `/projects/${job.project.id}/memory`;
}

export function DashboardClient({ username, isSystemAdmin = false }: { username: string; isSystemAdmin?: boolean }) {
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
    const riskyWorld = payload.worlds.find((entry) => entry.world.status === "at_risk");
    if (riskyWorld) {
      return { label: `核对「${riskyWorld.project.name}」的项目状态`, detail: `当前有 ${riskyWorld.world.counts.issues} 个问题、${riskyWorld.world.counts.risks} 个风险和 ${riskyWorld.world.counts.activeConflicts} 个事实冲突。`, href: `/projects/${riskyWorld.project.id}#current-state`, action: "打开项目概览" };
    }
    const atRisk = payload.operations.find((entry) => entry.health.status === "atRisk");
    if (atRisk) {
      return { label: `处理「${atRisk.project.name}」的计划风险`, detail: `当前有 ${atRisk.health.counts.overdue} 项逾期、${atRisk.health.counts.blocked} 项受阻。`, href: `/projects/${atRisk.project.id}/plan`, action: "打开项目计划" };
    }
    if (summary.projects === 0) {
      return { label: "创建第一个项目", detail: "项目会隔离资料、仓库、记忆和智能分析记录。", href: "/projects", action: "前往项目" };
    }
    const unrouted = projects.find((project) => project._count.webAiRoutes < 4);
    if (unrouted) {
      return { label: `完成「${unrouted.name}」的 AI 路由`, detail: "分别选择图片识别、语义向量、自动抽取和引用式问答供应商。", href: `/projects/${unrouted.id}/control`, action: "继续配置" };
    }
    if (summary.pendingAssetReviews > 0) {
      const current = projects.find((project) => project._count.assets > 0) ?? projects[0]!;
      return { label: "核对文件识别结果", detail: `${summary.pendingAssetReviews} 个文件正在等待人工确认，确认前不会进入项目记忆。`, href: `/projects/${current.id}/assets`, action: "进入文件资料" };
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
      <AppHeader username={username} active="dashboard" isSystemAdmin={isSystemAdmin} />
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

        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6" aria-label="项目概览指标">
          <MetricCard label="项目" value={payload.summary.projects} detail="统一工作空间" icon="folder" tone="indigo" loading={loading} />
          <MetricCard label="文件资料" value={payload.summary.assets} detail={payload.summary.pendingAssetReviews > 0 ? `${payload.summary.pendingAssetReviews} 个待确认` : "原件与定位片段"} icon="file" tone="cyan" loading={loading} />
          <MetricCard label="已确认事实" value={payload.summary.confirmedItems} detail="经过人工审核" icon="check" tone="emerald" loading={loading} />
          <MetricCard label="连接仓库" value={payload.summary.repositories} detail="多仓库只读来源" icon="branch" tone="cyan" loading={loading} />
          <MetricCard label="智能记忆" value={`${payload.summary.indexedProjects}/${payload.summary.projects}`} detail={payload.summary.activeJobs > 0 ? `${payload.summary.activeJobs} 个任务进行中` : payload.summary.indexedProjects > 0 ? `${payload.summary.indexedProjects} 个项目已建立索引` : "尚未建立活动索引"} icon="spark" tone="violet" loading={loading} />
          <MetricCard label="项目状态" value={payload.summary.atRiskWorlds + payload.summary.attentionWorlds} detail={payload.summary.atRiskWorlds > 0 ? `${payload.summary.atRiskWorlds} 个项目存在风险` : payload.summary.attentionWorlds > 0 ? `${payload.summary.attentionWorlds} 个项目需关注` : "当前状态稳定"} icon="alert" tone="rose" loading={loading} />
        </section>

        <WorldStatusPanel payload={payload} loading={loading} />
        <OperationsPanel payload={payload} loading={loading} />

        <section className="mt-6 grid gap-6 lg:grid-cols-[0.82fr_1.18fr]">
          <ReadinessPanel payload={payload} loading={loading} />
          <RecentJobs jobs={payload.recentJobs} loading={loading} />
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, detail, icon, tone, loading }: { label: string; value: string | number; detail: string; icon: string; tone: "indigo" | "emerald" | "cyan" | "violet" | "rose"; loading: boolean }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600",
    emerald: "bg-emerald-50 text-emerald-600",
    cyan: "bg-cyan-50 text-cyan-600",
    violet: "bg-violet-50 text-violet-600",
    rose: "bg-rose-50 text-rose-600",
  } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold text-slate-500">{label}</p>{loading ? <div className="mt-3 h-8 w-16 animate-pulse rounded bg-slate-100" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}</div><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><DashboardIcon name={icon} /></span></div><p className="mt-4 text-xs text-slate-500">{detail}</p></article>;
}

function OperationsPanel({ payload, loading }: { payload: DashboardPayload; loading: boolean }) {
  return <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Project operations</p><h2 className="mt-2 text-xl font-semibold">项目运营提醒</h2><p className="mt-2 text-xs leading-5 text-slate-500">这里只汇总需要处理的跨项目信号；项目创建、搜索和完整列表仍在独立“项目”入口。</p></div><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-rose-50 px-3 py-1 font-semibold text-rose-700">逾期 {payload.summary.overdueWorkItems}</span><span className="rounded-full bg-amber-50 px-3 py-1 font-semibold text-amber-700">受阻 {payload.summary.blockedWorkItems}</span><span className="rounded-full bg-cyan-50 px-3 py-1 font-semibold text-cyan-700">变更待评估 {payload.summary.openImpactSuggestions}</span><span className="rounded-full bg-violet-50 px-3 py-1 font-semibold text-violet-700">动作待审批 {payload.summary.pendingActionApprovals}</span></div></div>{loading ? <div className="mt-5 h-20 animate-pulse rounded-2xl bg-slate-100" /> : payload.operations.length === 0 ? <div className="mt-5 rounded-2xl bg-emerald-50 px-5 py-7 text-center text-sm text-emerald-700">当前没有逾期、受阻或其他需要关注的项目计划信号。</div> : <div className="mt-5 grid gap-3 lg:grid-cols-2">{payload.operations.map((entry) => <Link key={entry.project.id} href={`/projects/${entry.project.id}/plan`} className="group rounded-2xl border border-slate-200 p-4 transition hover:border-indigo-200 hover:bg-indigo-50/40"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-800">{entry.project.name}</h3><p className="mt-2 text-xs leading-5 text-slate-500">逾期 {entry.health.counts.overdue} · 受阻 {entry.health.counts.blocked} · 即将到期 {entry.health.counts.dueSoon} · 未分配 {entry.health.counts.unassigned}</p></div><span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${entry.health.status === "atRisk" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{entry.health.status === "atRisk" ? "需立即处理" : "待处理"}</span></div><p className="mt-3 text-xs font-semibold text-indigo-600">进入项目计划 →</p></Link>)}</div>}</section>;
}

function WorldStatusPanel({ payload, loading }: { payload: DashboardPayload; loading: boolean }) {
  const metadata = {
    at_risk: { label: "存在风险", tone: "bg-rose-100 text-rose-700", border: "hover:border-rose-200 hover:bg-rose-50/40" },
    needs_attention: { label: "需要关注", tone: "bg-amber-100 text-amber-700", border: "hover:border-amber-200 hover:bg-amber-50/40" },
    insufficient_data: { label: "资料不足", tone: "bg-slate-100 text-slate-600", border: "hover:border-slate-300 hover:bg-slate-50" },
    on_track: { label: "运行正常", tone: "bg-emerald-100 text-emerald-700", border: "hover:border-emerald-200 hover:bg-emerald-50/40" },
  } as const;
  return <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500">Project world state</p><h2 className="mt-2 text-xl font-semibold">跨项目状态提醒</h2><p className="mt-2 text-xs leading-5 text-slate-500">由已确认事实、关系、冲突和计划健康度确定性计算；点击项目会回到统一的项目概览。</p></div><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-rose-50 px-3 py-1 font-semibold text-rose-700">风险 {payload.summary.atRiskWorlds}</span><span className="rounded-full bg-amber-50 px-3 py-1 font-semibold text-amber-700">关注 {payload.summary.attentionWorlds}</span><span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-600">资料不足 {payload.summary.insufficientDataWorlds}</span></div></div>{loading ? <div className="mt-5 h-20 animate-pulse rounded-2xl bg-slate-100" /> : payload.worlds.length === 0 ? <div className="mt-5 rounded-2xl bg-emerald-50 px-5 py-7 text-center text-sm text-emerald-700">所有可访问项目的当前状态均为运行正常。</div> : <div className="mt-5 grid gap-3 lg:grid-cols-2">{payload.worlds.map((entry) => { const meta = metadata[entry.world.status]; return <Link key={entry.project.id} href={`/projects/${entry.project.id}#current-state`} className={`group rounded-2xl border border-slate-200 p-4 transition ${meta.border}`}><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-800">{entry.project.name}</h3><p className="mt-2 text-xs leading-5 text-slate-500">事实 {entry.world.counts.activeFacts} · 问题 {entry.world.counts.issues} · 风险 {entry.world.counts.risks} · 冲突 {entry.world.counts.activeConflicts}</p></div><span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${meta.tone}`}>{meta.label}</span></div><p className="mt-3 text-xs font-semibold text-indigo-600">进入项目概览 →</p></Link>; })}</div>}</section>;
}

function ReadinessPanel({ payload, loading }: { payload: DashboardPayload; loading: boolean }) {
  const steps = [
    { label: "项目空间", detail: "至少创建一个项目", done: payload.summary.projects > 0, href: "/projects" },
    { label: "能力路由", detail: `${payload.summary.routedProjects}/${payload.summary.projects} 个项目完成`, done: payload.summary.projects > 0 && payload.summary.routedProjects === payload.summary.projects, href: payload.projects[0] ? `/projects/${payload.projects[0].id}/control` : "/projects" },
    { label: "智能记忆", detail: `${payload.summary.indexedProjects}/${payload.summary.projects} 个项目有索引`, done: payload.summary.projects > 0 && payload.summary.indexedProjects === payload.summary.projects, href: payload.projects[0] ? `/projects/${payload.projects[0].id}/memory` : "/projects" },
  ];
  const completed = steps.filter((step) => step.done).length;
  return <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Setup progress</p><h2 className="mt-2 text-xl font-semibold">项目就绪度</h2></div><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">{loading ? "…" : `${completed}/3`}</span></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all" style={{ width: `${completed / steps.length * 100}%` }} /></div><div className="mt-5 space-y-2">{steps.map((step, index) => <Link key={step.label} href={step.href} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-slate-50"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${step.done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>{step.done ? "✓" : index + 1}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-700">{step.label}</span><span className="block truncate text-xs text-slate-400">{step.detail}</span></span><span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">→</span></Link>)}</div></section>;
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
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17.5h.01" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
