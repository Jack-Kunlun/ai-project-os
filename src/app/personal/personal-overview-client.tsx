"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type ResourceCount = number | "1+" | null;

type PersonalKnowledgeGraphNode = Readonly<{
  id: string;
  version: number;
  title: string;
  byteCount: number;
  updatedAt: string;
}>;

type PersonalKnowledgeGraphEdge = Readonly<{
  id: string;
  fromDocumentId: string;
  fromRevisionId: string;
  toDocumentId: string;
  toRevisionId: string;
  stale: boolean;
  createdAt: string;
}>;

type PersonalKnowledgeOverview = Readonly<{
  graph: Readonly<{
    nodes: readonly PersonalKnowledgeGraphNode[];
    edges: readonly PersonalKnowledgeGraphEdge[];
    truncated: boolean;
    maxNodes: number;
    maxEdges: number;
  }>;
  capacity: Readonly<{
    usedBytes: number;
    documentCount: number;
    limitBytes: null;
    limitLabel: string;
    measuredAt: string;
  }>;
  index: Readonly<{ status: string; label: string }>;
}>;

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
  knowledgeOverview: PersonalKnowledgeOverview | null;
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
  knowledgeOverview: null,
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

/** Parse the owner-scoped graph projection without manufacturing unavailable values. */
function parseKnowledgeOverview(value: unknown): PersonalKnowledgeOverview | null {
  const payload = asRecord(value);
  const graph = asRecord(payload?.graph);
  const capacity = asRecord(payload?.capacity);
  const index = asRecord(payload?.index);
  const nodes = asArray(graph?.nodes).flatMap((value) => {
    const node = asRecord(value);
    if (
      typeof node?.id !== "string"
      || typeof node.version !== "number"
      || typeof node.title !== "string"
      || typeof node.byteCount !== "number"
      || typeof node.updatedAt !== "string"
      || !Number.isSafeInteger(node.version)
      || !Number.isSafeInteger(node.byteCount)
      || node.byteCount < 0
    ) return [];
    return [{ id: node.id, version: node.version, title: node.title, byteCount: node.byteCount, updatedAt: node.updatedAt }];
  });
  const edges = asArray(graph?.edges).flatMap((value) => {
    const edge = asRecord(value);
    if (
      typeof edge?.id !== "string"
      || typeof edge.fromDocumentId !== "string"
      || typeof edge.fromRevisionId !== "string"
      || typeof edge.toDocumentId !== "string"
      || typeof edge.toRevisionId !== "string"
      || typeof edge.stale !== "boolean"
      || typeof edge.createdAt !== "string"
    ) return [];
    return [{
      id: edge.id,
      fromDocumentId: edge.fromDocumentId,
      fromRevisionId: edge.fromRevisionId,
      toDocumentId: edge.toDocumentId,
      toRevisionId: edge.toRevisionId,
      stale: edge.stale,
      createdAt: edge.createdAt,
    }];
  });
  if (
    graph === null
    || capacity === null
    || index === null
    || typeof graph.truncated !== "boolean"
    || typeof graph.maxNodes !== "number"
    || typeof graph.maxEdges !== "number"
    || typeof capacity.usedBytes !== "number"
    || typeof capacity.documentCount !== "number"
    || capacity.limitBytes !== null
    || typeof capacity.limitLabel !== "string"
    || typeof capacity.measuredAt !== "string"
    || typeof index.status !== "string"
    || typeof index.label !== "string"
    || !Number.isSafeInteger(capacity.usedBytes)
    || capacity.usedBytes < 0
    || !Number.isSafeInteger(capacity.documentCount)
    || capacity.documentCount < 0
  ) return null;
  return {
    graph: {
      nodes,
      edges,
      truncated: graph.truncated,
      maxNodes: graph.maxNodes,
      maxEdges: graph.maxEdges,
    },
    capacity: {
      usedBytes: capacity.usedBytes,
      documentCount: capacity.documentCount,
      limitBytes: null,
      limitLabel: capacity.limitLabel,
      measuredAt: capacity.measuredAt,
    },
    index: { status: index.status, label: index.label },
  };
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
      ["knowledge", "/api/personal/knowledge/overview", "知识库统计"],
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
    let knowledgeOverview: PersonalKnowledgeOverview | null = null;
    if (knowledgeResult?.status === "fulfilled") {
      knowledgeOverview = parseKnowledgeOverview(knowledgeResult.value);
      knowledgeCount = knowledgeOverview?.capacity.documentCount ?? null;
      if (knowledgeOverview === null) failures.push("知识库统计");
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
      knowledgeOverview,
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
            <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">我的空间</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里统一展示当前账号可访问的项目和个人资源。个人知识留在个人空间，项目资料与记忆留在各自项目；项目 A 的约定不会自动成为项目 B 的规则。</p>
          </div>
          <Link href="/personal/configuration" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50">管理个人资源</Link>
        </div>
      </section>

      {state.error ? <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{state.error}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重新加载</button></div> : null}
      {state.partialFailures.length > 0 ? <p role="status" className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">部分统计暂不可用：{state.partialFailures.join("、")}。项目和其他已加载内容仍可继续使用。</p> : null}

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-6" aria-label="我的空间统计">
        <MetricCard label="进行中项目" value={state.loading ? "…" : String(state.activeProjects)} href="/personal/projects" />
        <MetricCard label="已归档项目" value={state.loading ? "…" : String(state.archivedProjects)} href="/personal/projects" />
        <MetricCard label="知识文档" value={state.loading ? "…" : countLabel(state.knowledgeCount)} href="/personal/knowledge" />
        <MetricCard label="模型连接" value={state.loading ? "…" : countLabel(state.modelCount)} href="/personal/models" />
        <MetricCard label="Git 连接" value={state.loading ? "…" : countLabel(state.gitCount)} href="/personal/connections/git" />
        <MetricCard label="MCP 连接" value={state.loading ? "…" : countLabel(state.mcpCount)} href="/personal/connections/mcp" />
      </section>

      <KnowledgeOverviewSection
        loading={state.loading}
        overview={state.knowledgeOverview}
        onReload={() => void load()}
      />

      <section className="mt-7 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Accessible projects</p><h2 className="mt-2 text-2xl font-semibold">最近访问范围内的项目</h2><p className="mt-2 text-sm text-slate-500">这里只展示当前账号有权读取的最近 8 个进行中项目。</p></div>
          <Link href="/personal/projects" className="text-sm font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">查看全部项目 →</Link>
        </div>
        {state.loading ? <div className="mt-6 grid gap-4 md:grid-cols-2"><div className="h-36 animate-pulse rounded-2xl bg-slate-100" /><div className="h-36 animate-pulse rounded-2xl bg-slate-100" /></div> : state.projects.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">当前没有可访问的进行中项目</p><p className="mt-2 text-xs text-slate-500">个人知识库和个人连接仍可独立使用；获得项目权限后会显示在这里。</p></div> : <div className="mt-6 grid gap-4 md:grid-cols-2">{state.projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>}
      </section>

      <section className="mt-7 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-6 text-sm leading-7 text-indigo-950 sm:p-7">
        <h2 className="text-lg font-semibold">生效顺序</h2>
        <p className="mt-2">我的空间保存个人资源所有权；项目配置保存该项目的委托、选择和限制。进入项目执行任务时，以项目当前有效配置为准，不会因为个人连接存在就自动启用。</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full bg-white px-3 py-1.5 text-indigo-800">Git 已关联项目 {countLabel(state.gitProjectCount)}</span><span className="rounded-full bg-white px-3 py-1.5 text-indigo-800">MCP 已关联项目 {countLabel(state.mcpProjectCount)}</span></div>
      </section>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function graphTitle(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 18 ? normalized : `${normalized.slice(0, 17)}…`;
}

/** Render the owner-only graph and the capacity/index facts used by Dashboard. */
function KnowledgeOverviewSection({
  loading,
  overview,
  onReload,
}: Readonly<{
  loading: boolean;
  overview: PersonalKnowledgeOverview | null;
  onReload: () => void;
}>): React.JSX.Element {
  const [fromDocumentId, setFromDocumentId] = useState("");
  const [toDocumentId, setToDocumentId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nodes = overview?.graph.nodes ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const positions = nodes.map((node, index) => {
    const angle = nodes.length <= 1 ? 0 : (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return { node, x: nodes.length <= 1 ? 50 : 50 + Math.cos(angle) * 38, y: nodes.length <= 1 ? 50 : 50 + Math.sin(angle) * 35 };
  });
  const positionById = new Map(positions.map((position) => [position.node.id, position]));
  const resolvedFromDocumentId = nodeById.has(fromDocumentId) ? fromDocumentId : nodes[0]?.id ?? "";
  const resolvedToDocumentId = nodeById.has(toDocumentId) && toDocumentId !== resolvedFromDocumentId
    ? toDocumentId
    : nodes.find((node) => node.id !== resolvedFromDocumentId)?.id ?? "";

  async function createRelation(): Promise<void> {
    if (resolvedFromDocumentId === "" || resolvedToDocumentId === "" || resolvedFromDocumentId === resolvedToDocumentId) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const response = await fetch("/api/personal/knowledge/relations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromDocumentId: resolvedFromDocumentId, toDocumentId: resolvedToDocumentId }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("关联保存失败，请刷新后重试");
      onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "关联保存失败，请刷新后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeRelation(relationId: string): Promise<void> {
    setSubmitting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/personal/knowledge/relations/${encodeURIComponent(relationId)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("解除关联失败，请刷新后重试");
      onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "解除关联失败，请刷新后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-7 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7" aria-labelledby="personal-knowledge-overview-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Personal knowledge</p>
          <h2 id="personal-knowledge-overview-title" className="mt-2 text-2xl font-semibold">个人知识网状连接</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">图中只展示你明确建立的文档关联。文档编辑后，关联会保留创建时的版本并标记为需要复核。</p>
        </div>
        <div className="flex flex-wrap gap-4"><Link href="/personal/knowledge" className="text-sm font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">打开知识库 →</Link><Link href="/personal/knowledge/graph" className="text-sm font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">完整知识图谱 →</Link></div>
      </div>

      {loading ? <div className="mt-6 h-64 animate-pulse rounded-2xl bg-slate-100" /> : overview === null ? <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-8 text-sm text-amber-800">个人知识图与容量暂不可用，请稍后重新加载。</div> : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-3" aria-label="知识库容量与索引状态">
            <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">知识文档</p><p className="mt-2 text-2xl font-semibold text-slate-950">{overview.capacity.documentCount}</p><p className="mt-1 text-xs text-slate-500">当前有效文档</p></div>
            <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">已用容量</p><p className="mt-2 text-2xl font-semibold text-slate-950">{formatBytes(overview.capacity.usedBytes)}</p><p className="mt-1 text-xs text-slate-500">按当前版本正文 UTF-8 字节统计 · {overview.capacity.limitLabel}</p></div>
            <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">索引状态</p><p className="mt-2 text-base font-semibold text-amber-700">{overview.index.label}</p><p className="mt-1 text-xs text-slate-500">统计时间 {formatDate(overview.capacity.measuredAt)}</p></div>
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-slate-800">连接图</p>{overview.graph.truncated ? <span className="text-xs font-semibold text-amber-700">已达到展示上限</span> : null}</div>
              {nodes.length === 0 ? <div className="flex min-h-56 items-center justify-center text-center"><div><p className="text-sm font-semibold text-slate-700">还没有可展示的知识节点</p><p className="mt-2 text-xs text-slate-500">先在知识库创建一条个人知识，再建立关联。</p></div></div> : <>
                <svg className="mt-2 h-64 w-full" viewBox="0 0 100 100" role="img" aria-label="个人知识文档关联图">
                  <title>个人知识文档关联图</title>
                  {overview.graph.edges.map((edge) => {
                    const from = positionById.get(edge.fromDocumentId);
                    const to = positionById.get(edge.toDocumentId);
                    if (from === undefined || to === undefined) return null;
                    return <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={edge.stale ? "#f59e0b" : "#818cf8"} strokeDasharray={edge.stale ? "2 2" : undefined} strokeWidth="0.8" />;
                  })}
                  {positions.map(({ node, x, y }) => <g key={node.id}><circle cx={x} cy={y} r="6" fill="#312e81" /><text x={x} y={y + 1.2} textAnchor="middle" fontSize="3.2" fill="white">{node.title.slice(0, 2)}</text></g>)}
                </svg>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">{nodes.map((node, index) => <Link key={node.id} href={`/personal/knowledge?document=${encodeURIComponent(node.id)}`} className="rounded-xl bg-white px-3 py-2 text-xs text-slate-700 hover:text-indigo-700"><span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-800">{index + 1}</span>{graphTitle(node.title)}<span className="ml-2 text-slate-400">{formatBytes(node.byteCount)}</span></Link>)}</div>
              </>}
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-800">明确建立的关联</p>
              {overview.graph.edges.length === 0 ? <p className="mt-5 text-sm text-slate-500">暂无关联。选择两个知识节点即可建立第一条边。</p> : <ul className="mt-4 space-y-3">{overview.graph.edges.map((edge) => <li key={edge.id} className="rounded-xl bg-slate-50 px-3 py-3"><div className="flex items-start justify-between gap-3"><p className="text-xs leading-5 text-slate-700">{graphTitle(nodeById.get(edge.fromDocumentId)?.title ?? "未知文档")} <span className="text-slate-400">↔</span> {graphTitle(nodeById.get(edge.toDocumentId)?.title ?? "未知文档")}</p><button type="button" disabled={submitting} onClick={() => void revokeRelation(edge.id)} className="shrink-0 text-xs font-semibold text-slate-500 underline underline-offset-2 hover:text-rose-700">解除</button></div>{edge.stale ? <p className="mt-2 text-xs font-semibold text-amber-700">文档版本已变化，需要重新确认</p> : null}</li>)}</ul>}
              {nodes.length >= 2 ? <div className="mt-5 border-t border-slate-200 pt-4"><p className="text-xs font-semibold text-slate-600">建立新关联</p><div className="mt-3 grid gap-2"><select aria-label="关联起点" value={resolvedFromDocumentId} onChange={(event) => setFromDocumentId(event.target.value)} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700">{nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select><select aria-label="关联终点" value={resolvedToDocumentId} onChange={(event) => setToDocumentId(event.target.value)} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700">{nodes.filter((node) => node.id !== resolvedFromDocumentId).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select><button type="button" disabled={submitting || resolvedFromDocumentId === "" || resolvedToDocumentId === ""} onClick={() => void createRelation()} className="min-h-10 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{submitting ? "保存中…" : "建立关联"}</button></div></div> : null}
              {actionError ? <p role="alert" className="mt-3 text-xs text-rose-700">{actionError}</p> : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Render one account or project count as a navigable summary card. */
function MetricCard({ label, value, href }: Readonly<{ label: string; value: string; href: string }>): React.JSX.Element {
  return <Link href={href} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p></Link>;
}

/** Show project state without duplicating lifecycle controls from `/projects`. */
function ProjectCard({ project }: Readonly<{ project: PersonalProjectSummary }>): React.JSX.Element {
  return (
    <article className="flex h-full flex-col rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
      <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="truncate text-lg font-semibold text-slate-900">{project.name}</h3><p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500">{project.description ?? "暂无项目描述。"}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${project.memoryReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{project.memoryReady ? "记忆就绪" : "待建立记忆"}</span></div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600"><span className="rounded-lg bg-white px-2.5 py-1.5">事实 {project.itemCount}</span><span className="rounded-lg bg-white px-2.5 py-1.5">仓库 {project.repositoryCount}</span><span className="rounded-lg bg-white px-2.5 py-1.5">更新于 {formatDate(project.updatedAt)}</span></div>
      <div className="mt-auto flex border-t border-slate-200/70 pt-4"><Link href={`/projects/${project.id}`} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-600">进入项目 →</Link></div>
    </article>
  );
}
