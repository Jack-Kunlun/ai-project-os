"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

type ProjectItem = {
  id: string;
  type: "decision" | "progress" | "issue" | "risk";
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
  title: string;
  content: string;
  updatedAt: string;
};

type ProjectSource = {
  id: string;
  kind: "document" | "screenshot" | "github" | "manual";
  externalRef: string | null;
  contentText: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
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

type ErrorPayload = {
  error?: { message?: string };
};

const labels = {
  sources: { title: "Sources", subtitle: "项目资料来源", icon: "01" },
  items: { title: "Items", subtitle: "事实与判断条目", icon: "02" },
  snapshots: { title: "Snapshot", subtitle: "项目当前状态", icon: "03" },
} as const;

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorPayload;
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function getProject(projectId: string): Promise<Project> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
  const payload = (await response.json()) as { project?: Project; error?: { message?: string } };
  if (!response.ok || !payload.project) {
    throw new Error(payload.error?.message ?? "项目加载失败");
  }
  return payload.project;
}

async function getSources(projectId: string): Promise<ProjectSource[]> {
  const response = await fetch(`/api/projects/${projectId}/sources`, { cache: "no-store" });
  const payload = (await response.json()) as { sources?: ProjectSource[]; error?: { message?: string } };
  if (!response.ok || !payload.sources) {
    throw new Error(payload.error?.message ?? "项目资料加载失败");
  }
  return payload.sources;
}

function formatSourceDate(value: string | null): string {
  if (!value) return "未填写";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间无效";

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function sourcePreview(contentText: string): string {
  const compact = contentText.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceSuccess, setSourceSuccess] = useState<string | null>(null);
  const [isSourcesLoading, setIsSourcesLoading] = useState(true);
  const [isCreatingSource, setIsCreatingSource] = useState(false);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [sourceExternalRef, setSourceExternalRef] = useState("");
  const [sourceCapturedAt, setSourceCapturedAt] = useState("");

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    void getProject(projectId)
      .then((loadedProject) => {
        if (!cancelled) setProject(loadedProject);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "项目加载失败");
      });

    void getSources(projectId)
      .then((loadedSources) => {
        if (!cancelled) setSources(loadedSources);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setSourceError(loadError instanceof Error ? loadError.message : "项目资料加载失败");
      })
      .finally(() => {
        if (!cancelled) setIsSourcesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function reloadProjectAndSources(): Promise<void> {
    if (!projectId) return;

    setIsSourcesLoading(true);
    const [projectResult, sourcesResult] = await Promise.allSettled([getProject(projectId), getSources(projectId)]);

    if (projectResult.status === "fulfilled") {
      setProject(projectResult.value);
      setError(null);
    } else {
      setError(projectResult.reason instanceof Error ? projectResult.reason.message : "项目加载失败");
    }

    if (sourcesResult.status === "fulfilled") {
      setSources(sourcesResult.value);
      setSourceError(null);
    } else {
      setSourceError(sourcesResult.reason instanceof Error ? sourcesResult.reason.message : "项目资料加载失败");
    }

    setIsSourcesLoading(false);
  }

  async function handleSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !sourceContent.trim()) return;

    let capturedAt: string | undefined;
    if (sourceCapturedAt) {
      const capturedDate = new Date(sourceCapturedAt);
      if (Number.isNaN(capturedDate.getTime())) {
        setSourceError("资料时间格式无效");
        setSourceSuccess(null);
        return;
      }
      capturedAt = capturedDate.toISOString();
    }

    setIsCreatingSource(true);
    setSourceError(null);
    setSourceSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentText: sourceContent,
          externalRef: sourceExternalRef,
          capturedAt,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, "资料保存失败"));
      }

      setSourceContent("");
      setSourceExternalRef("");
      setSourceCapturedAt("");
      await reloadProjectAndSources();
      setSourceSuccess("候选资料已保存。");
    } catch (createError) {
      setSourceError(createError instanceof Error ? createError.message : "资料保存失败");
    } finally {
      setIsCreatingSource(false);
    }
  }

  async function handleDeleteSource(source: ProjectSource) {
    if (!projectId || deletingSourceId) return;
    if (!window.confirm("这会永久删除这条候选资料，且仅适用于尚未被 Item 引用的来源。确定继续吗？")) return;

    setDeletingSourceId(source.id);
    setSourceError(null);
    setSourceSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sources/${source.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response, "资料删除失败"));
      }

      await reloadProjectAndSources();
      setSourceSuccess("候选资料已删除。");
    } catch (deleteError) {
      setSourceError(deleteError instanceof Error ? deleteError.message : "资料删除失败");
    } finally {
      setDeletingSourceId(null);
    }
  }

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
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">V0 · Day 2</span>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <PlaceholderCard {...labels.sources} count={project._count.sources} detail="已接入人工候选资料；内容仍需后续确认，不等同于可信事实。" />
        <PlaceholderCard {...labels.items} count={project._count.items} detail="提取与确认将在 Day 3 开始" />
        <PlaceholderCard {...labels.snapshots} count={project._count.snapshots} detail="快照生成将在 Day 4–5 开始" />
      </section>

      <section aria-labelledby="sources-heading" className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Source intake</p>
            <h2 id="sources-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">项目资料</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">手工接入原始候选资料，保留精确内容与 SHA-256，供后续条目提取追溯。</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isSourcesLoading ? "读取中…" : `${sources.length} 条候选资料`}</span>
        </div>

        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="note">
          <strong className="font-semibold">安全提示：</strong>这里只保存候选资料，不代表已确认的事实或 AI 摘要。不要录入密码、Token、私密连接串，也不要使用带凭据的 URL。
        </div>

        {sourceError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">{sourceError}</div>
        ) : null}
        {sourceSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{sourceSuccess}</div>
        ) : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[0.72fr_1.28fr]">
          <form onSubmit={handleSourceSubmit} className="rounded-2xl bg-slate-950 p-6 text-white shadow-lg shadow-slate-950/10" aria-labelledby="source-form-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Manual source</p>
            <h3 id="source-form-heading" className="mt-3 text-xl font-semibold tracking-tight">接入一条候选资料</h3>

            <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="source-external-ref">来源链接 <span className="font-normal text-slate-500">（可选）</span></label>
            <input
              id="source-external-ref"
              type="url"
              value={sourceExternalRef}
              onChange={(event) => setSourceExternalRef(event.target.value)}
              placeholder="https://example.com/document"
              maxLength={2048}
              autoComplete="url"
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="source-captured-at">资料时间 <span className="font-normal text-slate-500">（可选）</span></label>
            <input
              id="source-captured-at"
              type="datetime-local"
              value={sourceCapturedAt}
              onChange={(event) => setSourceCapturedAt(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="source-content">原始资料内容 <span className="text-rose-300">（必填）</span></label>
            <textarea
              id="source-content"
              value={sourceContent}
              onChange={(event) => setSourceContent(event.target.value)}
              placeholder="粘贴项目日报、会议记录或其他原始资料……"
              maxLength={100000}
              rows={10}
              required
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">保留原文空格与换行；内容预览只做确定性截取，不会生成摘要。</p>
            <button
              type="submit"
              disabled={isCreatingSource || !sourceContent.trim()}
              className="mt-5 flex w-full items-center justify-center rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingSource ? "保存中…" : "保存候选资料"}
            </button>
          </form>

          <div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Traceable inputs</p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">已接入资料</h3>
              </div>
              <span className="text-xs text-slate-400">按最近接入排序</span>
            </div>

            {isSourcesLoading ? (
              <div className="mt-5 space-y-3" aria-label="正在加载项目资料">
                {[1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-slate-100" />)}
              </div>
            ) : sources.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
                <p className="text-sm font-medium text-slate-700">还没有候选资料</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">从左侧接入第一条原始内容，之后可以在这里查看精确 hash 与原文。</p>
              </div>
            ) : (
              <ul className="mt-5 space-y-4" aria-label="项目候选资料列表">
                {sources.map((source) => (
                  <li key={source.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">{source.kind}</span>
                        <span className="text-xs text-slate-500">资料时间：{formatSourceDate(source.capturedAt)}</span>
                        <span className="text-xs text-slate-400">接入于：{formatSourceDate(source.ingestedAt)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSource(source)}
                        disabled={deletingSourceId !== null}
                        className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`删除候选资料 ${sourcePreview(source.contentText).slice(0, 24)}`}
                      >
                        {deletingSourceId === source.id ? "删除中…" : "删除"}
                      </button>
                    </div>

                    {source.externalRef ? (
                      <a href={source.externalRef} target="_blank" rel="noopener noreferrer" className="mt-4 block truncate text-sm font-medium text-indigo-600 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-700" title={source.externalRef}>
                        {source.externalRef}
                      </a>
                    ) : (
                      <p className="mt-4 text-sm text-slate-400">未提供外部链接</p>
                    )}

                    <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">内容预览（非 AI 摘要）</p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{sourcePreview(source.contentText)}</p>

                    <details className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <summary className="cursor-pointer text-sm font-medium text-slate-700">查看原文</summary>
                      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">{source.contentText}</pre>
                    </details>

                    <div className="mt-4 border-t border-slate-200 pt-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">SHA-256</p>
                      <code className="mt-2 block break-all text-xs leading-5 text-slate-600">{source.contentHash}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
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
            还没有条目。接入来源后，这里会显示可追溯的 decision、progress、issue 和 risk。
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
