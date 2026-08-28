"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { LogoutButton } from "@/app/logout-button";

type Project = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  updatedAt: string;
  _count: {
    sources: number;
    items: number;
    scans: number;
    snapshots: number;
  };
};

type ErrorPayload = {
  error?: { message?: string };
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorPayload;
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

export function HomeClient() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readError(response, "项目列表加载失败"));
      }
      const payload = (await response.json()) as { projects: Project[] };
      setProjects(payload.projects);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目列表加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;

    setIsCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, "项目创建失败"));
      }
      const payload = (await response.json()) as { project: Project };
      setProjects((current) => [payload.project, ...current]);
      setName("");
      setDescription("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "项目创建失败");
    } finally {
      setIsCreating(false);
    }
  }

  const totals = useMemo(
    () =>
      projects.reduce(
        (summary, project) => ({
          sources: summary.sources + project._count.sources,
          items: summary.items + project._count.items,
          snapshots: summary.snapshots + project._count.snapshots,
        }),
        { sources: 0, items: 0, snapshots: 0 },
      ),
    [projects],
  );

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <header className="flex items-center justify-between border-b border-slate-200/80 pb-7">
          <Link href="/" className="flex items-center gap-3" aria-label="AI Project OS 首页">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold tracking-tight text-white">OS</span>
            <span>
              <span className="block text-sm font-semibold tracking-[0.16em] text-slate-950">AI PROJECT OS</span>
              <span className="mt-0.5 block text-xs text-slate-500">AI Memory · V2.0</span>
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/settings" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700">模型与系统设置</Link>
            <LogoutButton />
          </div>
        </header>

        <section className="grid gap-10 pb-12 pt-14 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-indigo-600">Understand your project</p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-slate-950 sm:text-6xl">
              让项目状态，<span className="text-indigo-600">一眼可被理解。</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              从人工资料和 GitHub 多仓库到自动抽取、统一向量索引与引用式问答。配置、同步、审核和检索都可以在页面完成。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 lg:pb-1">
            <Metric label="Projects" value={projects.length} />
            <Metric label="Items" value={totals.items} />
            <Metric label="Snapshots" value={totals.snapshots} />
          </div>
        </section>

        {error ? (
          <div className="mb-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void loadProjects()} className="font-semibold underline underline-offset-4">重试</button>
          </div>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
          <form onSubmit={handleCreate} className="rounded-3xl bg-slate-950 p-7 text-white shadow-xl shadow-slate-950/10 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Start here</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight">创建一个项目</h2>
              </div>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">项目入口</span>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-400">项目是所有来源、事实条目和快照的容器。名称确定后，后续可以继续补充资料。</p>
            <label className="mt-7 block text-sm font-medium text-slate-200" htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：私域商城"
              maxLength={120}
              required
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />
            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="project-description">一句话描述 <span className="font-normal text-slate-500">（可选）</span></label>
            <textarea
              id="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个项目要解决什么问题？"
              maxLength={2000}
              rows={3}
              className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />
            <button
              type="submit"
              disabled={isCreating || !name.trim()}
              className="mt-6 flex w-full items-center justify-center rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? "创建中…" : "创建项目"}
            </button>
          </form>

          <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Workspace</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">你的项目</h2>
              </div>
              <span className="text-sm text-slate-400">{isLoading ? "读取中…" : `${projects.length} 个项目`}</span>
            </div>

            {isLoading ? (
              <div className="mt-7 space-y-3" aria-label="正在加载项目">
                {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-2xl bg-slate-100" />)}
              </div>
            ) : projects.length === 0 ? (
              <div className="mt-7 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
                <p className="text-sm font-medium text-slate-700">还没有项目</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">从左侧创建第一个项目，建立项目资料与记忆入口。</p>
              </div>
            ) : (
              <div className="mt-7 space-y-3">
                {projects.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`} className="group flex items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-slate-50/70 px-5 py-4 transition hover:border-indigo-200 hover:bg-indigo-50/50">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                        <h3 className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">{project.name}</h3>
                      </div>
                      <p className="mt-2 truncate pl-5 text-xs text-slate-500">{project.description || "等待接入第一条项目资料"}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-slate-500">{project._count.items} items</p>
                      <p className="mt-1 text-[11px] text-slate-400">更新于 {formatDate(project.updatedAt)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        <footer className="mt-12 flex flex-col gap-2 border-t border-slate-200/80 pt-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <span>Facts first · Every future insight should be traceable to a source.</span>
          <span>AI Project OS V2.0</span>
        </footer>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white px-4 py-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
    </div>
  );
}
