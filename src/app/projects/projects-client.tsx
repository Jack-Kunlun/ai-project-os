"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { jobStatusLabels, type JobKind, type WorkspaceProject } from "@/lib/workspace-summary";

type ProjectsPayload = { projects: WorkspaceProject[] };

const jobLabels: Record<JobKind, string> = {
  githubScan: "代码扫描",
  githubMaterialSync: "仓库资料同步",
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

export function ProjectsClient({ username }: { username: string }) {
  const [payload, setPayload] = useState<ProjectsPayload>({ projects: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "项目列表加载失败"));
      setPayload(await response.json() as ProjectsPayload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filteredProjects = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return payload.projects;
    return payload.projects.filter((project) =>
      `${project.name} ${project.description ?? ""} ${project.slug}`.toLocaleLowerCase("zh-CN").includes(keyword),
    );
  }, [payload.projects, search]);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="projects" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-9 sm:px-8 lg:px-10">
        <section className="flex flex-col gap-5 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Projects</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">我的项目</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">集中管理项目空间，并直接进入资料、智能控制台、记忆或智能体。</p>
          </div>
          <button type="button" onClick={() => setCreateOpen(true)} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500">＋ 新建项目</button>
        </section>

        {error ? <div className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold underline underline-offset-4">重试</button></div> : null}

        <section className="mt-7" aria-label="项目列表">
          <div className="flex flex-col gap-4 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-500">
              {loading ? "正在读取项目…" : <><span className="font-semibold text-slate-800">{filteredProjects.length}</span><span> 个项目</span>{search ? <span className="text-slate-400"> · 共 {payload.projects.length} 个</span> : null}</>}
            </div>
            <label className="relative block min-w-0 sm:w-72">
              <span className="sr-only">搜索项目</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute left-3.5 top-3.5 h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、描述或 slug" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-10 pr-4 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-100" />
            </label>
          </div>

          {loading ? (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">{[1, 2].map((item) => <div key={item} className="h-64 animate-pulse rounded-3xl bg-slate-200" />)}</div>
          ) : filteredProjects.length === 0 ? (
            <div className="mt-5 rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
              <p className="text-base font-semibold text-slate-800">{payload.projects.length === 0 ? "还没有项目" : "没有匹配的项目"}</p>
              <p className="mt-2 text-sm text-slate-500">{payload.projects.length === 0 ? "创建项目后，就可以录入资料、连接仓库并建立智能记忆。" : "换一个项目名称、描述或 slug 关键词试试。"}</p>
              {payload.projects.length === 0 ? <button type="button" onClick={() => setCreateOpen(true)} className="mt-5 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white">创建第一个项目</button> : null}
            </div>
          ) : (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              {filteredProjects.map((project) => <ProjectCard key={project.id} project={project} />)}
            </div>
          )}
        </section>
      </div>

      {createOpen ? <CreateProjectDialog onClose={() => setCreateOpen(false)} onCreated={load} /> : null}
    </main>
  );
}

function ProjectCard({ project }: { project: WorkspaceProject }) {
  const checks = [project._count.sources > 0, project._count.webAiRoutes === 3, project.memoryIndexPointer !== null];
  const progress = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  const latestJob = project.backgroundJobs[0];
  return <article className="group rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-xl hover:shadow-indigo-950/5"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><Link href={`/projects/${project.id}`} className="block truncate text-xl font-semibold tracking-tight text-slate-900 transition group-hover:text-indigo-700">{project.name}</Link><p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">{project.description || "还没有项目描述。进入资料与条目补充背景，让后续记忆更容易理解。"}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${project.memoryIndexPointer ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{project.memoryIndexPointer ? "记忆就绪" : "待建立记忆"}</span></div><div className="mt-5 grid grid-cols-3 gap-2"><SmallStat label="事实" value={project._count.items} /><SmallStat label="仓库" value={project._count.repositoryLinks} /><SmallStat label="智能体运行" value={project._count.projectAgentRuns} /></div><div className="mt-5"><div className="flex items-center justify-between text-[11px] text-slate-400"><span>配置进度</span><span>{progress}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${progress}%` }} /></div></div><div className="mt-5 flex flex-wrap gap-2"><QuickLink href={`/projects/${project.id}`} label="资料" /><QuickLink href={`/projects/${project.id}/control`} label="控制台" /><QuickLink href={`/projects/${project.id}/memory`} label="记忆" /><QuickLink href={`/projects/${project.id}/intelligence`} label="智能体" primary /></div><div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-[11px] text-slate-400"><span>更新于 {formatDate(project.updatedAt)}</span><span>{latestJob ? `${jobLabels[latestJob.kind]} · ${jobStatusLabels[latestJob.status]}` : "暂无任务"}</span></div></article>;
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl bg-slate-50 px-3 py-3"><p className="text-lg font-semibold text-slate-800">{value}</p><p className="mt-0.5 text-[10px] text-slate-400">{label}</p></div>;
}

function QuickLink({ href, label, primary = false }: { href: string; label: string; primary?: boolean }) {
  return <Link href={href} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${primary ? "bg-slate-950 text-white hover:bg-indigo-600" : "border border-slate-200 text-slate-600 hover:border-indigo-200 hover:text-indigo-700"}`}>{label}</Link>;
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !pending) onClose(); }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description }) });
      if (!response.ok) throw new Error(await readError(response, "项目创建失败"));
      await onCreated();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "项目创建失败");
    } finally {
      setPending(false);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="create-project-title" className="w-full max-w-lg rounded-t-[2rem] bg-white p-7 shadow-2xl sm:rounded-[2rem] sm:p-8"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New project</p><h2 id="create-project-title" className="mt-2 text-2xl font-semibold">创建项目空间</h2><p className="mt-2 text-sm leading-6 text-slate-500">项目会隔离自己的资料、仓库、模型路由和智能记忆。</p></div><button type="button" onClick={onClose} disabled={pending} className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200" aria-label="关闭">×</button></div><form onSubmit={submit} className="mt-7"><label htmlFor="projects-project-name" className="text-sm font-semibold text-slate-700">项目名称</label><input id="projects-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder="例如：AI Project OS" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /><label htmlFor="projects-project-description" className="mt-5 block text-sm font-semibold text-slate-700">项目描述 <span className="font-normal text-slate-400">（可选）</span></label><textarea id="projects-project-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={4} placeholder="这个项目在解决什么问题？当前最重要的目标是什么？" className="mt-2 w-full resize-none rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />{error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}<div className="mt-7 flex justify-end gap-3"><button type="button" onClick={onClose} disabled={pending} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600">取消</button><button disabled={pending || !name.trim()} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "创建中…" : "创建项目"}</button></div></form></section></div>;
}
