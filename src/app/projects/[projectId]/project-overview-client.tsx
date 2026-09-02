"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { isProjectSnapshotStale } from "@/lib/project-snapshot-stale";
import type { SnapshotRecord } from "@/lib/project-snapshot";

type Project = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  _count: { sources: number; assets: number; items: number; scans: number; snapshots: number };
};

type ProjectItem = {
  id: string;
  type: "decision" | "progress" | "issue" | "risk";
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
  confirmedAt: string | null;
};

type GovernanceSummary = {
  pendingReviews: { web: number; verified: number; total: number };
  jobs: { reconciliationRequired: number; failed: number };
  github: { partial: number; rateLimited: number; unknown: number };
  index: { readiness: string; compatible: boolean; activeRecordCount: number };
  attentionTotal: number;
};

type OverviewData = {
  project: Project;
  items: ProjectItem[];
  snapshot: SnapshotRecord | null;
  governance: GovernanceSummary;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as ({ error?: { message?: string } } & Partial<T>) | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? fallback);
  return payload as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectOverviewClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotPending, setSnapshotPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [projectPayload, itemsPayload, snapshotPayload, governancePayload] = await Promise.all([
        readJson<{ project: Project }>(await fetch(`/api/projects/${projectId}`, { cache: "no-store" }), "项目加载失败"),
        readJson<{ items: ProjectItem[] }>(await fetch(`/api/projects/${projectId}/items`, { cache: "no-store" }), "项目事实加载失败"),
        readJson<{ snapshot: SnapshotRecord | null }>(await fetch(`/api/projects/${projectId}/snapshots`, { cache: "no-store" }), "项目快照加载失败"),
        readJson<{ summary: GovernanceSummary }>(await fetch(`/api/projects/${projectId}/governance`, { cache: "no-store" }), "项目提醒加载失败"),
      ]);
      setData({
        project: projectPayload.project,
        items: itemsPayload.items,
        snapshot: snapshotPayload.snapshot,
        governance: governancePayload.summary,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目概览加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(() => {
    if (data === null) return null;
    const confirmed = data.items.filter((item) => item.reviewStatus === "confirmed");
    const candidates = data.items.filter((item) => item.reviewStatus === "candidate").length;
    const snapshotStale = data.snapshot ? isProjectSnapshotStale(data.snapshot.payload, data.items) : false;
    const githubIssues = data.governance.github.partial + data.governance.github.rateLimited + data.governance.github.unknown;
    const taskIssues = data.governance.jobs.failed + data.governance.jobs.reconciliationRequired;
    const focus = data.snapshot?.payload.counts.focus ?? 0;
    const pendingContent = Math.max(data.governance.pendingReviews.total, candidates);
    const attentionTotal = data.governance.attentionTotal - data.governance.pendingReviews.total + pendingContent;
    return { confirmed, candidates, snapshotStale, githubIssues, taskIssues, focus, pendingContent, attentionTotal };
  }, [data]);

  async function generateSnapshot() {
    if (data === null || summary === null || summary.confirmed.length === 0 || snapshotPending) return;
    setSnapshotPending(true);
    setError(null);
    setMessage(null);
    try {
      await readJson<{ snapshot: SnapshotRecord }>(await fetch(`/api/projects/${projectId}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }), "项目快照生成失败");
      await load();
      setMessage("项目状态快照已更新。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目快照生成失败");
    } finally {
      setSnapshotPending(false);
    }
  }

  const nextStep = (() => {
    if (data === null || summary === null) return null;
    if (data.project._count.sources === 0 && data.project._count.assets === 0) return { title: "添加第一份项目资料", detail: "输入文本，或上传图片、文档和文件夹。", href: `/projects/${projectId}/materials`, action: "添加资料" };
    if (summary.pendingContent > 0) return { title: "审核待确认内容", detail: "只有人工确认后的内容才会进入项目事实与记忆。", href: `/projects/${projectId}/governance`, action: "开始审核" };
    if (!data.governance.index.compatible) return { title: "建立或更新项目记忆", detail: "把已确认内容建立为可检索、可引用的语义索引。", href: `/projects/${projectId}/memory`, action: "管理记忆" };
    return { title: "查询项目或生成简报", detail: "当前项目已经具备可引用的智能查询基础。", href: `/projects/${projectId}/intelligence`, action: "打开 AI 工作台" };
  })();

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="overview" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        {loading ? (
          <div className="space-y-5" aria-label="正在加载项目概览"><div className="h-64 animate-pulse rounded-[2rem] bg-slate-200" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-32 animate-pulse rounded-2xl bg-slate-200" />)}</div></div>
        ) : data === null || summary === null || nextStep === null ? (
          <div role="alert" className="flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error ?? "项目概览加载失败"}</span><button type="button" onClick={() => void load({ showLoading: true })} className="font-semibold underline underline-offset-4">重试</button></div>
        ) : (
          <>
            <section className="relative overflow-hidden rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10 lg:px-12">
              <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-indigo-500/30 blur-3xl" />
              <div className="relative grid gap-8 lg:grid-cols-[1.25fr_0.75fr] lg:items-end">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Project overview</p>
                  <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">{data.project.name}</h1>
                  <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">{data.project.description || "尚未填写项目描述。这里仅汇总项目现状；资料录入和详细管理在独立页面完成。"}</p>
                  <div className="mt-7 flex flex-wrap gap-3">
                    <Link href={`/projects/${projectId}/materials`} className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50">项目资料</Link>
                    <Link href={`/projects/${projectId}/intelligence`} className="rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/15">AI 工作台</Link>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.07] p-5 backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-200">推荐下一步</p>
                  <h2 className="mt-4 text-xl font-semibold">{nextStep.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{nextStep.detail}</p>
                  <Link href={nextStep.href} className="mt-5 inline-flex text-sm font-semibold text-indigo-200 hover:text-white">{nextStep.action} →</Link>
                </div>
              </div>
            </section>

            {data.project.archivedAt ? <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">项目已归档，当前概览为只读状态。</p> : null}
            {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}
            {message ? <p role="status" className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700">{message}</p> : null}

            <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="项目关键指标">
              <MetricCard label="资料来源" value={data.project._count.sources} detail="文本、网页与仓库来源" tone="indigo" />
              <MetricCard label="文件" value={data.project._count.assets} detail="图片、文档与文件夹内容" tone="cyan" />
              <MetricCard label="已确认事实" value={summary.confirmed.length} detail={`全部条目 ${data.project._count.items}`} tone="emerald" />
              <MetricCard label="待处理" value={summary.attentionTotal} detail="审核、异常与人工收口" tone={summary.attentionTotal > 0 ? "rose" : "slate"} />
            </section>

            <section className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
              <article className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500">Current state</p><h2 className="mt-2 text-xl font-semibold">项目当前状态</h2></div>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${data.snapshot === null ? "bg-slate-100 text-slate-600" : summary.focus > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>{data.snapshot === null ? "尚无快照" : summary.focus > 0 ? "需要关注" : "状态稳定"}</span>
                </div>
                {data.snapshot ? (
                  <><div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4"><StateCount label="决策" value={data.snapshot.payload.counts.decisions} /><StateCount label="进展" value={data.snapshot.payload.counts.progress} /><StateCount label="问题" value={data.snapshot.payload.counts.issues} /><StateCount label="风险" value={data.snapshot.payload.counts.risks} /></div><p className="mt-5 text-xs text-slate-400">更新于 {formatDate(data.snapshot.generatedAt)}{summary.snapshotStale ? " · 已有新确认内容，建议更新" : " · 与当前确认内容一致"}</p></>
                ) : <p className="mt-6 rounded-2xl bg-slate-50 px-5 py-8 text-center text-sm text-slate-500">确认项目事实后，可生成第一份状态快照。</p>}
                <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => void generateSnapshot()} disabled={snapshotPending || summary.confirmed.length === 0 || data.project.archivedAt !== null} className="rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{snapshotPending ? "更新中…" : data.snapshot ? "更新状态快照" : "生成状态快照"}</button><Link href={`/projects/${projectId}/world`} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700">查看完整状态</Link></div>
              </article>

              <article className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
                <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Attention</p><h2 className="mt-2 text-xl font-semibold">需要关注</h2></div>
                <div className="mt-5 divide-y divide-slate-100">
                  <AttentionRow label="待审核内容" value={summary.pendingContent} href={`/projects/${projectId}/governance`} />
                  <AttentionRow label="任务异常" value={summary.taskIssues} href={`/projects/${projectId}/governance`} />
                  <AttentionRow label="仓库同步风险" value={summary.githubIssues} href={`/projects/${projectId}/repositories`} />
                </div>
                <Link href={`/projects/${projectId}/governance`} className="mt-5 inline-flex text-xs font-semibold text-indigo-600">进入审核与治理 →</Link>
              </article>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "indigo" | "cyan" | "emerald" | "rose" | "slate" }) {
  const tones = { indigo: "bg-indigo-50 text-indigo-700", cyan: "bg-cyan-50 text-cyan-700", emerald: "bg-emerald-50 text-emerald-700", rose: "bg-rose-50 text-rose-700", slate: "bg-slate-100 text-slate-600" } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p></div><span aria-hidden="true" className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><span className="h-2.5 w-2.5 rounded-full bg-current" /></span></div><p className="mt-4 text-xs text-slate-500">{detail}</p></article>;
}

function StateCount({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl bg-slate-50 px-4 py-4 text-center"><strong className="text-2xl font-semibold">{value}</strong><span className="mt-1 block text-xs text-slate-500">{label}</span></div>;
}

function AttentionRow({ label, value, href }: { label: string; value: number; href: string }) {
  return <Link href={href} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"><span className="text-sm font-medium text-slate-700">{label}</span><span className={`rounded-full px-3 py-1 text-xs font-semibold ${value > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{value > 0 ? value : "正常"}</span></Link>;
}
