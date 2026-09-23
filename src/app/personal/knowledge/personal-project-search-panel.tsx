"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type ProjectOption = Readonly<{
  id: string;
  name: string;
  archivedAt: string | null;
}>;

type ProjectSearchCitation = Readonly<{
  sourceId: string;
  sourceKind: string;
  externalRef: string | null;
  chunkId: string;
  rangeUnit: "utf8_byte" | "line";
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
}>;

type ProjectSearchResult = Readonly<{
  rank: number;
  score: number;
  projectId: string;
  projectName: string;
  snapshotId: string;
  citation: ProjectSearchCitation;
}>;

type ProjectSearchPayload = Readonly<{
  results?: readonly ProjectSearchResult[];
  selectedProjects?: readonly Readonly<{ id: string; name: string; archived: boolean }>[];
}>;

type ProjectListPayload = Readonly<{
  projects?: readonly ProjectOption[];
}>;

const MAX_SELECTED_PROJECTS = 5;

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return typeof payload?.error?.message === "string" && payload.error.message.trim().length > 0
    ? payload.error.message
    : fallback;
}

function sourceKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    document: "文件",
    screenshot: "截图",
    github: "GitHub",
    git: "Git",
    web: "网页",
    manual: "手动资料",
    mcp: "MCP",
  };
  return labels[kind] ?? "项目资料";
}

/**
 * Keep optional project search explicit: personal knowledge remains the
 * default scope, while this panel lets the user choose at most five projects.
 */
export function PersonalProjectSearchPanel(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scope, setScope] = useState<"selected" | "allAccessible">("selected");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ProjectSearchResult[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const projectsRequestRef = useRef<AbortController | null>(null);
  const searchRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    projectsRequestRef.current?.abort();
    projectsRequestRef.current = controller;
    void Promise.all([
      fetch("/api/projects?view=active&page=1&pageSize=50", { cache: "no-store", signal: controller.signal }),
      fetch("/api/projects?view=archived&page=1&pageSize=50", { cache: "no-store", signal: controller.signal }),
    ]).then(async ([activeResponse, archivedResponse]) => {
      if (!activeResponse.ok) throw new Error(await responseError(activeResponse, "可选项目加载失败"));
      if (!archivedResponse.ok) throw new Error(await responseError(archivedResponse, "可选项目加载失败"));
      const [activePayload, archivedPayload] = await Promise.all([
        activeResponse.json() as Promise<ProjectListPayload>,
        archivedResponse.json() as Promise<ProjectListPayload>,
      ]);
      const byId = new Map<string, ProjectOption>();
      for (const project of [...(activePayload.projects ?? []), ...(archivedPayload.projects ?? [])]) byId.set(project.id, project);
      setProjects([...byId.values()]);
      setProjectError(null);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setProjectError(cause instanceof Error ? cause.message : "可选项目加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingProjects(false);
    });
    return () => {
      controller.abort();
      if (projectsRequestRef.current === controller) projectsRequestRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    projectsRequestRef.current?.abort();
    searchRequestRef.current?.abort();
  }, []);

  const selectedProjects = useMemo(
    () => selectedIds.map((id) => projects.find((project) => project.id === id)).filter((project): project is ProjectOption => project !== undefined),
    [projects, selectedIds],
  );

  function toggleProject(projectId: string): void {
    setSelectedIds((current) => {
      if (current.includes(projectId)) return current.filter((id) => id !== projectId);
      if (current.length >= MAX_SELECTED_PROJECTS) return current;
      return [...current, projectId];
    });
    setResults([]);
    setError(null);
  }

  async function searchProjects(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (scope === "selected" && selectedIds.length === 0) {
      setError("请先选择至少一个项目。");
      return;
    }
    if (trimmed.length === 0) {
      setError("请输入要搜索的内容。");
      return;
    }
    searchRequestRef.current?.abort();
    const controller = new AbortController();
    searchRequestRef.current = controller;
    setSearching(true);
    setError(null);
    try {
      const response = await fetch("/api/personal/knowledge/project-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify(scope === "allAccessible"
          ? { scope, query: trimmed, take: 10 }
          : { scope, projectIds: selectedIds, query: trimmed, take: 10 }),
      });
      if (!response.ok) throw new Error(await responseError(response, "项目搜索失败"));
      const payload = await response.json() as ProjectSearchPayload;
      setResults(payload.results ?? []);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setResults([]);
      setError(cause instanceof Error ? cause.message : "项目搜索失败");
    } finally {
      if (searchRequestRef.current === controller) searchRequestRef.current = null;
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="personal-project-search-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Optional project scope</p>
          <h2 id="personal-project-search-title" className="mt-2 text-lg font-semibold text-slate-900">搜索项目资料</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">个人知识库仍是默认范围。可搜索明确选中的项目，或本次搜索时仍有权访问的全部项目；不会复制项目内容或调用模型。</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">最多 {MAX_SELECTED_PROJECTS} 个项目</span>
      </div>

      <div className="mt-5">
        <fieldset className="mb-4 flex flex-wrap gap-2" aria-label="项目搜索范围">
          <legend className="sr-only">项目搜索范围</legend>
          <label className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-semibold ${scope === "selected" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600"}`}><input className="sr-only" type="radio" name="project-search-scope" value="selected" checked={scope === "selected"} onChange={() => { setScope("selected"); setResults([]); setError(null); }} />选定项目</label>
          <label className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-semibold ${scope === "allAccessible" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600"}`}><input className="sr-only" type="radio" name="project-search-scope" value="allAccessible" checked={scope === "allAccessible"} onChange={() => { setScope("allAccessible"); setResults([]); setError(null); }} />全部可访问项目</label>
        </fieldset>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-slate-700">选择项目</p>
          <span className="text-xs text-slate-400">已选 {selectedIds.length}/{MAX_SELECTED_PROJECTS}</span>
        </div>
        {loadingProjects ? <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">正在读取可访问项目…</p> : null}
        {projectError ? <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700" role="alert">{projectError}</p> : null}
        {!loadingProjects && projectError === null && projects.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-slate-200 px-4 py-4 text-xs text-slate-500">当前没有可选项目。</p> : null}
        {scope === "selected" && projects.length > 0 ? (
          <div className="mt-3 flex max-h-36 flex-wrap gap-2 overflow-y-auto" aria-label="可搜索项目">
            {projects.map((project) => {
              const selected = selectedIds.includes(project.id);
              const disabled = !selected && selectedIds.length >= MAX_SELECTED_PROJECTS;
              return <button key={project.id} type="button" onClick={() => toggleProject(project.id)} disabled={disabled} aria-pressed={selected} className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold transition ${selected ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-slate-50"} disabled:cursor-not-allowed disabled:opacity-45`}>
                {project.name}<span className="ml-1.5 font-normal text-slate-400">{project.archivedAt === null ? "进行中" : "已归档"}</span>
              </button>;
            })}
          </div>
        ) : null}
      </div>

      <form onSubmit={searchProjects} className="mt-5 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="sr-only">搜索已选项目资料</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={240} placeholder="例如：发布前检查、当前里程碑…" disabled={searching} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-100 disabled:opacity-60" />
        </label>
        <button type="submit" disabled={searching || (scope === "selected" && selectedIds.length === 0)} className="rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50">{searching ? "搜索中…" : "搜索项目资料"}</button>
      </form>

      {error ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700" role="alert">{error}</p> : null}
      {scope === "allAccessible" ? <p className="mt-4 text-xs text-slate-400">当前范围：本次搜索时仍有权访问的全部项目（最多 50 个）</p> : selectedProjects.length > 0 ? <p className="mt-4 text-xs text-slate-400">当前范围：{selectedProjects.map((project) => project.name).join("、")}</p> : null}
      {!searching && results.length === 0 && (scope === "allAccessible" || selectedProjects.length > 0) && query.trim().length > 0 && error === null ? <p className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-xs text-slate-500">没有找到匹配的项目资料。</p> : null}
      {results.length > 0 ? <ol className="mt-4 space-y-3" aria-label="项目搜索结果">
        {results.map((result) => <li key={`${result.projectId}:${result.citation.chunkId}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500"><span className="font-semibold text-indigo-700">#{result.rank} {result.projectName}</span><span>·</span><span>{sourceKindLabel(result.citation.sourceKind)}</span><span>·</span><span>来源 {result.citation.sourceId.slice(0, 8)}…</span><span>·</span><span>当前索引 {result.snapshotId.slice(0, 8)}…</span></div>
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">{result.citation.excerpt}</p>
          <p className="mt-2 text-xs text-slate-400">内容指纹 {result.citation.contentHash.slice(0, 12)}… · 片段 {result.citation.rangeStart}–{result.citation.rangeEnd}</p>
        </li>)}
      </ol> : null}
    </section>
  );
}
