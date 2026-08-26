"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

type ProjectItem = {
  id: string;
  type: "decision" | "progress" | "issue" | "risk";
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
  title: string;
  content: string;
  updatedAt: string;
};

type Project = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    sources: number;
    items: number;
    scans: number;
    snapshots: number;
  };
  items: ProjectItem[];
};

const labels = {
  sources: { title: "Sources", subtitle: "项目资料来源", icon: "01" },
  items: { title: "Items", subtitle: "事实与判断条目", icon: "02" },
  snapshots: { title: "Snapshot", subtitle: "项目当前状态", icon: "03" },
} as const;

async function getProject(projectId: string): Promise<Project> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
  const payload = (await response.json()) as { project?: Project; error?: { message?: string } };
  if (!response.ok || !payload.project) {
    throw new Error(payload.error?.message ?? "项目加载失败");
  }
  return payload.project;
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId)
      .then(setProject)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "项目加载失败"));
  }, [projectId]);

  if (error) {
    return <ProjectShell><div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div></ProjectShell>;
  }

  if (!project) {
    return <ProjectShell><div className="h-40 animate-pulse rounded-3xl bg-slate-100" aria-label="正在加载项目" /></ProjectShell>;
  }

  return (
    <ProjectShell>
      <div className="flex flex-col gap-6 border-b border-slate-200/80 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← 返回项目列表</Link>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Project workspace</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-slate-950">{project.name}</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{project.description || "项目描述尚未补充。先接入来源，AI 才能开始建立可追溯的项目理解。"}</p>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">V0 · 基础骨架</span>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <PlaceholderCard {...labels.sources} count={project._count.sources} detail="来源接入将在 Day 2 开始" />
        <PlaceholderCard {...labels.items} count={project._count.items} detail="提取与确认将在 Day 3 开始" />
        <PlaceholderCard {...labels.snapshots} count={project._count.snapshots} detail="快照生成将在 Day 4–5 开始" />
      </section>

      <section className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Recent items</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">最近的项目条目</h2>
          </div>
          <span className="text-xs text-slate-400">只读预览</span>
        </div>
        {project.items.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-8 text-center text-sm text-slate-500">
            还没有条目。Day 2 接入来源后，这里会显示可追溯的 decision、progress、issue 和 risk。
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {project.items.map((item) => (
              <div key={item.id} className="rounded-2xl border border-slate-100 bg-slate-50/70 px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-indigo-100 px-2 py-1 text-[11px] font-semibold uppercase text-indigo-700">{item.type}</span>
                  <span className="text-xs text-slate-400">{item.reviewStatus}</span>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-slate-900">{item.title}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">{item.content}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </ProjectShell>
  );
}

function ProjectShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <header className="flex items-center justify-between border-b border-slate-200/80 pb-7">
          <Link href="/" className="flex items-center gap-3" aria-label="AI Project OS 首页">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold tracking-tight text-white">OS</span>
            <span className="block text-sm font-semibold tracking-[0.16em] text-slate-950">AI PROJECT OS</span>
          </Link>
          <span className="text-xs text-slate-400">Project Snapshot · V0</span>
        </header>
        <div className="py-10">{children}</div>
      </div>
    </main>
  );
}

function PlaceholderCard({ title, subtitle, icon, count, detail }: { title: string; subtitle: string; icon: string; count: number; detail: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-500">{icon}</span>
        <span className="text-3xl font-semibold tracking-tight text-slate-950">{count}</span>
      </div>
      <h2 className="mt-8 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-400">{detail}</p>
    </div>
  );
}
