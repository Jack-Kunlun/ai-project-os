"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";

type ProjectSource = {
  id: string;
  kind: "document" | "screenshot" | "github" | "git" | "web" | "manual" | "mcp";
  externalRef: string | null;
  contentText: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
};

function formatDate(value: string | null): string {
  if (!value) return "未填写";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间无效" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function getSource(projectId: string, sourceId: string): Promise<ProjectSource> {
  const response = await fetch(`/api/projects/${projectId}/sources/${sourceId}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null) as { source?: ProjectSource; error?: { message?: string } } | null;
  if (!response.ok || payload?.source === undefined) throw new Error(payload?.error?.message ?? "资料原文加载失败");
  return payload.source;
}

export function ProjectSourceDetailClient({ username }: { username: string }) {
  const { projectId, sourceId } = useParams<{ projectId: string; sourceId: string }>();
  const searchParams = useSearchParams();
  const fromNotifications = searchParams.get("from") === "notifications";
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSource(await getSource(projectId, sourceId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资料原文加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, sourceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="materials" />
      <div className="mx-auto max-w-5xl px-6 py-8 sm:px-10 lg:px-12">
        <div className="mb-6">{fromNotifications ? <ParentPageLink href="/notifications" label="返回通知中心" /> : <ProjectMaterialsParentLink projectId={projectId} />}</div>
        <section className="pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Source detail</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目资料详情</h1>
          <p className="mt-3 font-mono text-xs text-slate-400 [overflow-wrap:anywhere]">{sourceId}</p>
        </section>
        {error ? <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-3 font-semibold underline underline-offset-4">重试</button></div> : null}
        {loading && !source ? <div className="h-72 animate-pulse rounded-3xl bg-slate-200" aria-label="正在加载资料详情" /> : source ? <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-6 sm:p-7"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">{source.kind}</span><span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">候选资料</span></div><h2 className="mt-4 text-xl font-semibold">原始资料内容</h2></div><span className="text-xs text-slate-400">接入于 {formatDate(source.ingestedAt)}</span></div><dl className="grid gap-4 border-b border-slate-100 p-6 text-sm sm:grid-cols-2 sm:p-7"><div><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">资料时间</dt><dd className="mt-1 text-slate-700">{formatDate(source.capturedAt)}</dd></div><div><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">外部来源</dt><dd className="mt-1 break-all text-slate-700">{source.externalRef ?? "未提供外部来源"}</dd></div></dl><div className="p-6 sm:p-7"><pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-slate-950 p-5 text-sm leading-7 text-slate-200">{source.contentText}</pre><div className="mt-6 rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">SHA-256</p><code className="mt-2 block break-all text-xs leading-5 text-slate-600">{source.contentHash}</code></div></div></section> : null}
      </div>
    </main>
  );
}
