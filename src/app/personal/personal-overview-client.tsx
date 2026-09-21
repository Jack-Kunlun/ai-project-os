"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type ResourceCount = number | "1+" | null;

/** Minimal project projection shown outside the full project management page. */
type PersonalProjectSummary = Readonly<{
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  repositoryCount: number;
  itemCount: number;
  memoryReady: boolean;
}>;

type PersonalOverviewState = Readonly<{
  loading: boolean;
  error: string | null;
  activeProjects: number;
  archivedProjects: number;
  projects: readonly PersonalProjectSummary[];
  knowledgeCount: ResourceCount;
  modelCount: ResourceCount;
  gitCount: ResourceCount;
  mcpCount: ResourceCount;
  gitProjectCount: ResourceCount;
  mcpProjectCount: ResourceCount;
  partialFailures: readonly string[];
}>;

const initialState: PersonalOverviewState = {
  loading: true,
  error: null,
  activeProjects: 0,
  archivedProjects: 0,
  projects: [],
  knowledgeCount: null,
  modelCount: null,
  gitCount: null,
  mcpCount: null,
  gitProjectCount: null,
  mcpProjectCount: null,
  partialFailures: [],
};

/** Accept only record-like JSON before reading an allowlisted field. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Return an array only when the server field actually has list shape. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parse one project card without trusting optional API response fields. */
function parseProject(value: unknown): PersonalProjectSummary | null {
  const record = asRecord(value);
  const counts = asRecord(record?._count);
  if (record === null || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.updatedAt !== "string") return null;
  const description = typeof record.description === "string" ? record.description : null;
  return {
    id: record.id,
    name: record.name,
    description,
    updatedAt: record.updatedAt,
    repositoryCount: typeof counts?.repositoryLinks === "number" ? counts.repositoryLinks : 0,
    itemCount: typeof counts?.items === "number" ? counts.items : 0,
    memoryReady: record.memoryIndexPointer !== null && record.memoryIndexPointer !== undefined,
  };
}

/** Read a non-negative count while keeping unavailable data distinct from zero. */
function parseCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Fetch JSON with an abort signal and a stable user-facing failure label. */
async function readJson(endpoint: string, signal: AbortSignal, label: string): Promise<unknown> {
  const response = await fetch(endpoint, { cache: "no-store", signal });
  if (!response.ok) throw new Error(label);
  return response.json();
}

/** Format project activity timestamps without allowing invalid dates to leak. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "更新时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Show resource counts as unavailable instead of turning failed reads into zero. */
function countLabel(value: ResourceCount): string {
  return value === null ? "暂不可用" : String(value);
}

/**
 * Aggregate only account-visible APIs. Project access continues to be decided
 * by `/api/projects`; this page never broadens membership or admin scope.
 */
export function PersonalOverviewClient(): React.JSX.Element {
  const [state, setState] = useState<PersonalOverviewState>(initialState);
  const requestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const tokenRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.controller.abort();
    const request = { token: ++tokenRef.current, controller: new AbortController() };
    requestRef.current = request;
    setState((current) => ({ ...current, loading: true, error: null, partialFailures: [] }));

    const endpoints = [
      ["projects", "/api/projects?view=active&page=1&pageSize=8", "项目总览加载失败"],
      ["knowledge", "/api/personal/knowledge?limit=1", "知识库统计"],
      ["models", "/api/me/ai-providers", "模型连接统计"],
      ["git", "/api/me/git-connections", "Git 连接统计"],
      ["mcp", "/api/me/mcp-connections", "MCP 连接统计"],
      ["gitDelegations", "/api/me/git-delegations", "Git 项目使用统计"],
      ["mcpDelegations", "/api/me/mcp-delegations", "MCP 项目使用统计"],
    ] as const;
    const results = await Promise.allSettled(endpoints.map(([, endpoint, label]) => readJson(endpoint, request.controller.signal, label)));
    if (request.controller.signal.aborted || requestRef.current?.token !== request.token) return;

    const projectsResult = results[0];
    if (projectsResult.status === "rejected") {
      setState({ ...initialState, loading: false, error: projectsResult.reason instanceof Error ? projectsResult.reason.message : "项目总览加载失败" });
      requestRef.current = null;
      return;
    }

    const projectPayload = asRecord(projectsResult.value);
    const counts = asRecord(projectPayload?.counts);
    const failures: string[] = [];
    const resourceCount = (index: number, field: string, label: string): ResourceCount => {
      const result = results[index];
      if (result?.status !== "fulfilled") {
        failures.push(label);
        return null;
      }
      return asArray(asRecord(result.value)?.[field]).length;
    };
    const knowledgeResult = results[1];
    let knowledgeCount: ResourceCount = null;
    if (knowledgeResult?.status === "fulfilled") {
      const knowledgePayload = asRecord(knowledgeResult.value);
      const pagination = asRecord(knowledgePayload?.pagination);
      knowledgeCount = parseCount(pagination?.total);
      if (knowledgeCount === null) {
        const documents = asArray(knowledgePayload?.documents);
        knowledgeCount = documents.length > 0 && typeof knowledgePayload?.nextCursor === "string" ? "1+" : documents.length;
      }
    } else {
      failures.push("知识库统计");
    }
    const delegatedProjectCount = (index: number, label: string): ResourceCount => {
      const result = results[index];
      if (result?.status !== "fulfilled") {
        failures.push(label);
        return null;
      }
      const projectIds = new Set<string>();
      for (const value of asArray(asRecord(result.value)?.delegations)) {
        const delegation = asRecord(value);
        const project = asRecord(delegation?.project);
        const projectId = typeof project?.id === "string"
          ? project.id
          : typeof delegation?.projectId === "string" ? delegation.projectId : null;
        if (projectId !== null) projectIds.add(projectId);
      }
      return projectIds.size;
    };

    setState({
      loading: false,
      error: null,
      activeProjects: parseCount(counts?.active) ?? 0,
      archivedProjects: parseCount(counts?.archived) ?? 0,
      projects: asArray(projectPayload?.projects).map(parseProject).filter((project): project is PersonalProjectSummary => project !== null),
      knowledgeCount,
      modelCount: resourceCount(2, "providers", "模型连接统计"),
      gitCount: resourceCount(3, "connections", "Git 连接统计"),
      mcpCount: resourceCount(4, "connections", "MCP 连接统计"),
      gitProjectCount: delegatedProjectCount(5, "Git 项目使用统计"),
      mcpProjectCount: delegatedProjectCount(6, "MCP 项目使用统计"),
      partialFailures: failures,
    });
    requestRef.current = null;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.controller.abort();
      requestRef.current = null;
      tokenRef.current += 1;
    };
  }, [load]);

  return (
    <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
      <section className="rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-11">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Personal workspace</p>
        <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">个人工作区总览</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">集中查看你拥有的知识与连接，以及当前账号可以访问的项目。项目自己的委托、选择和安全规则决定最终生效配置。</p>
          </div>
          <Link href="/personal/configuration" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50">管理个人资源</Link>
        </div>
      </section>

      {state.error ? <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{state.error}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重新加载</button></div> : null}
      {state.partialFailures.length > 0 ? <p role="status" className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">部分统计暂不可用：{state.partialFailures.join("、")}。项目和其他已加载内容仍可继续使用。</p> : null}

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-6" aria-label="个人工作区统计">
        <MetricCard label="进行中项目" value={state.loading ? "…" : String(state.activeProjects)} href="/projects" />
        <MetricCard label="已归档项目" value={state.loading ? "…" : String(state.archivedProjects)} href="/projects" />
        <MetricCard label="知识文档" value={state.loading ? "…" : countLabel(state.knowledgeCount)} href="/personal/knowledge" />
        <MetricCard label="模型连接" value={state.loading ? "…" : countLabel(state.modelCount)} href="/personal/models" />
        <MetricCard label="Git 连接" value={state.loading ? "…" : countLabel(state.gitCount)} href="/personal/connections/git" />
        <MetricCard label="MCP 连接" value={state.loading ? "…" : countLabel(state.mcpCount)} href="/personal/connections/mcp" />
      </section>

      <section className="mt-7 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Accessible projects</p><h2 className="mt-2 text-2xl font-semibold">最近访问范围内的项目</h2><p className="mt-2 text-sm text-slate-500">这里只展示当前账号有权读取的最近 8 个进行中项目。</p></div>
          <Link href="/projects" className="text-sm font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">查看全部项目 →</Link>
        </div>
        {state.loading ? <div className="mt-6 grid gap-4 md:grid-cols-2"><div className="h-36 animate-pulse rounded-2xl bg-slate-100" /><div className="h-36 animate-pulse rounded-2xl bg-slate-100" /></div> : state.projects.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">当前没有可访问的进行中项目</p><p className="mt-2 text-xs text-slate-500">个人知识库和个人连接仍可独立使用；获得项目权限后会显示在这里。</p></div> : <div className="mt-6 grid gap-4 md:grid-cols-2">{state.projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>}
      </section>

      <section className="mt-7 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-6 text-sm leading-7 text-indigo-950 sm:p-7">
        <h2 className="text-lg font-semibold">生效顺序</h2>
        <p className="mt-2">个人工作区保存资源所有权；项目配置保存该项目的委托、选择和限制。进入项目执行任务时，以项目当前有效配置为准，不会因为个人连接存在就自动启用。</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full bg-white px-3 py-1.5 text-indigo-800">Git 已关联项目 {countLabel(state.gitProjectCount)}</span><span className="rounded-full bg-white px-3 py-1.5 text-indigo-800">MCP 已关联项目 {countLabel(state.mcpProjectCount)}</span></div>
      </section>
    </div>
  );
}

/** Render one account or project count as a navigable summary card. */
function MetricCard({ label, value, href }: Readonly<{ label: string; value: string; href: string }>): React.JSX.Element {
  return <Link href={href} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p></Link>;
}

/** Show project state without duplicating lifecycle controls from `/projects`. */
function ProjectCard({ project }: Readonly<{ project: PersonalProjectSummary }>): React.JSX.Element {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
      <div className="flex items-start justify-between gap-4"><div className="min-w-0"><Link href={`/projects/${project.id}`} className="block truncate text-lg font-semibold text-slate-900 hover:text-indigo-700">{project.name}</Link><p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500">{project.description ?? "暂无项目描述。"}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${project.memoryReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{project.memoryReady ? "记忆就绪" : "待建立记忆"}</span></div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600"><span className="rounded-lg bg-white px-2.5 py-1.5">事实 {project.itemCount}</span><span className="rounded-lg bg-white px-2.5 py-1.5">仓库 {project.repositoryCount}</span><span className="rounded-lg bg-white px-2.5 py-1.5">更新于 {formatDate(project.updatedAt)}</span></div>
      <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-200/70 pt-4"><Link href={`/projects/${project.id}`} className="text-xs font-semibold text-indigo-700">项目概览 →</Link><Link href={`/projects/${project.id}/configuration`} className="text-xs font-semibold text-slate-600 hover:text-indigo-700">项目配置 →</Link></div>
    </article>
  );
}
