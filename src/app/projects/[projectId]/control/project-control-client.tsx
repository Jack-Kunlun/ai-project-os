"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { jobStatusLabels, type JobAttemptSummary } from "@/lib/workspace-summary";

type Provider = {
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  status: "configured" | "verified" | "error";
  defaultGenerationModelId: string;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
};
type AiRoute = {
  operation: "embedding" | "visionExtract" | "autoExtract" | "generateWithContext";
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
  updatedAt: string;
};
type RouteImpact = {
  changed: boolean;
  onlyFutureRuns: boolean;
  indexInvalidated: boolean;
  requiresIndexRebuildAcknowledgement: boolean;
  activeIndexGenerationId: string | null;
  activeIndex: { indexGenerationId: string; providerConnectionId: string; providerName: string; providerKind: string; modelId: string; dimensions: number } | null;
};
type RoutePreview = {
  current: AiRoute | null;
  next: Omit<AiRoute, "updatedAt">;
  impact: RouteImpact;
};
type RepositoryLink = {
  id: string;
  status: "active" | "disabled" | "unlinked" | "accessUnknown";
  eligible: boolean;
  repository: {
    currentFullName: string;
    private: boolean;
    archived: boolean;
    defaultBranch: string;
    lastVerifiedAt: string;
  };
  config: {
    role: string;
    requiredForProjectSnapshot: boolean;
    trackedRef: string;
    codeEnabled: boolean;
    metadataEnabled: boolean;
    readmeEnabled: boolean;
    markdownEnabled: boolean;
    issuesEnabled: boolean;
    pullRequestsEnabled: boolean;
    releasesEnabled: boolean;
    includeRoots: string[];
  };
};
type Job = {
  id: string;
  kind: "assetExtract" | "githubScan" | "githubMaterialSync" | "githubProjectSync" | "memoryIndex" | "autoExtract" | "semanticSearch" | "ragAnswer" | "projectBrief" | "projectAgent";
  status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  stage: string;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
  attempts: JobAttemptSummary[];
};

type GitHubJobResult = {
  status?: string;
  warning?: string;
  warnings?: string[];
  syncRunId?: string;
  counts?: { added?: number; updated?: number; deleted?: number; unchanged?: number; withheld?: number };
  reconciliationRequired?: boolean;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean))];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectControlClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [routes, setRoutes] = useState<AiRoute[]>([]);
  const [repositories, setRepositories] = useState<RepositoryLink[]>([]);
  const [credentialSuffix, setCredentialSuffix] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, routeResponse, repositoryResponse, jobResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/ai-routes`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/repositories`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !routeResponse.ok || !repositoryResponse.ok || !jobResponse.ok) {
        const failed = [projectResponse, routeResponse, repositoryResponse, jobResponse].find((response) => !response.ok)!;
        throw new Error(await readError(failed, "控制台加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const routePayload = await routeResponse.json() as { providers: Provider[]; routes: AiRoute[] };
      const repositoryPayload = await repositoryResponse.json() as { repositories: RepositoryLink[]; credential: { maskedSuffix: string } | null };
      const jobPayload = await jobResponse.json() as { jobs: Job[] };
      setProjectName(projectPayload.project.name);
      setProviders(routePayload.providers);
      setRoutes(routePayload.routes);
      setRepositories(repositoryPayload.repositories);
      setCredentialSuffix(repositoryPayload.credential?.maskedSuffix ?? null);
      setJobs(jobPayload.jobs);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "控制台加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="control" />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Control plane</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">选择每项 AI 能力使用的供应商，并在页面连接多个 GitHub 仓库。仓库读取始终冻结到明确 commit，扫描结果按仓库级原子发布。</p></section>
        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {loading ? <div className="h-40 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <AiRouteSection projectId={projectId} providers={providers} routes={routes} onChanged={setRoutes} />
            <RepositorySection projectId={projectId} repositories={repositories} credentialSuffix={credentialSuffix} onReload={reload} />
            <JobSection projectId={projectId} jobs={jobs} onReload={reload} />
          </>
        )}
      </div>
    </main>
  );
}

const operationInfo = {
  embedding: { title: "语义向量", description: "为项目资料和仓库内容建立语义索引。" },
  visionExtract: { title: "图片识别", description: "识别图片和扫描 PDF，并生成待人工核对的文字与视觉描述。" },
  autoExtract: { title: "自动抽取", description: "从原始资料抽取待人工审核的决策、进展、问题和风险。" },
  generateWithContext: { title: "引用式问答", description: "只基于检索到的项目证据生成带引用回答。" },
} as const;

function AiRouteSection({ projectId, providers, routes, onChanged }: { projectId: string; providers: Provider[]; routes: AiRoute[]; onChanged: (routes: AiRoute[]) => void }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
      <div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Capability routing</p><h2 className="mt-2 text-2xl font-semibold">项目模型路由</h2><p className="mt-2 text-sm leading-6 text-slate-500">仅能选择已通过连接测试且已配置对应模型的供应商。图片识别、自动抽取、向量索引与引用式生成可分别使用不同的国内外服务。</p></div>
      {providers.length === 0 ? <p className="mt-6 rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-800">还没有可用供应商。请先到 <Link href="/settings" className="font-semibold underline">模型与系统设置</Link> 添加并测试连接。</p> : <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{(["embedding", "visionExtract", "autoExtract", "generateWithContext"] as const).map((operation) => <RouteCard key={operation} operation={operation} projectId={projectId} providers={providers} current={routes.find((route) => route.operation === operation)} onSaved={(route) => onChanged([...routes.filter((item) => item.operation !== operation), route])} />)}</div>}
    </section>
  );
}

function RouteCard({ operation, projectId, providers, current, onSaved }: { operation: keyof typeof operationInfo; projectId: string; providers: Provider[]; current?: AiRoute; onSaved: (route: AiRoute) => void }) {
  const eligible = useMemo(() => providers.filter((provider) => provider.status === "verified" && (operation !== "embedding" || provider.defaultEmbeddingModelId !== null) && (operation !== "visionExtract" || provider.defaultVisionModelId !== null)), [providers, operation]);
  const deepSeekConfigured = providers.some((provider) => provider.kind === "deepseek");
  const [providerId, setProviderId] = useState(current?.providerConnectionId ?? eligible[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [previewForKey, setPreviewForKey] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [acknowledgeIndexRebuild, setAcknowledgeIndexRebuild] = useState(false);
  const [message, setMessage] = useState<ReactNode>(null);
  const provider = eligible.find((entry) => entry.id === providerId);

  const target = useMemo(() => {
    if (!provider) return null;
    const isEmbedding = operation === "embedding";
    return {
      operation,
      providerConnectionId: provider.id,
      modelId: isEmbedding ? provider.defaultEmbeddingModelId : operation === "visionExtract" ? provider.defaultVisionModelId : provider.defaultGenerationModelId,
      embeddingDimensions: isEmbedding ? provider.embeddingDimensions : null,
      maxOutputTokens: isEmbedding ? 128 : 2048,
      ...(current ? { expectedUpdatedAt: current.updatedAt } : { expectedUpdatedAt: null }),
    };
  }, [current, operation, provider]);

  const targetKey = JSON.stringify(target);

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setPreviewPending(Boolean(target));
      setPreviewError(null);
      setPreview(null);
      setPreviewForKey("");
      setAcknowledgeIndexRebuild(false);
      if (!target) return;
      try {
        const response = await fetch(`/api/projects/${projectId}/ai-routes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target),
        });
        if (!response.ok) throw new Error(await readError(response, "无法检查路由切换影响"));
        const nextPreview = await response.json() as RoutePreview;
        if (active) {
          setPreview(nextPreview);
          setPreviewForKey(targetKey);
        }
      } catch (previewLoadError: unknown) {
        if (active) setPreviewError(previewLoadError instanceof Error ? previewLoadError.message : "无法检查路由切换影响");
      } finally {
        if (active) setPreviewPending(false);
      }
    })();
    return () => { active = false; };
  }, [projectId, target, targetKey]);

  async function refreshPreviewAfterConflict(): Promise<void> {
    if (!target) return;
    setPreviewPending(true);
    setPreviewError(null);
    setPreview(null);
    setPreviewForKey("");
    setAcknowledgeIndexRebuild(false);
    try {
      const response = await fetch(`/api/projects/${projectId}/ai-routes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!response.ok) throw new Error(await readError(response, "无法重新检查路由切换影响"));
      const refreshed = await response.json() as RoutePreview;
      if (refreshed.current) onSaved(refreshed.current);
      setPreview(refreshed);
      setPreviewForKey(targetKey);
      setMessage("路由状态已变化，影响预览已刷新；请重新确认后再次保存。");
    } catch (refreshError: unknown) {
      setPreviewError(refreshError instanceof Error ? refreshError.message : "无法重新检查路由切换影响");
      setMessage("路由状态已变化，重新获取影响预览失败，请刷新页面后重试。");
    } finally {
      setPreviewPending(false);
    }
  }

  async function save() {
    if (!provider || !target || previewPending || previewError || previewForKey !== targetKey) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/ai-routes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target, acknowledgeIndexRebuild }) });
      if (!response.ok) {
        if (response.status === 409) {
          await refreshPreviewAfterConflict();
          return;
        }
        throw new Error(await readError(response, "路由保存失败"));
      }
      const result = await response.json() as { route: AiRoute; impact: RouteImpact };
      onSaved(result.route);
      setMessage(result.impact.indexInvalidated
        ? <span>已保存；语义搜索、RAG 和项目智能体已暂停。请前往 <Link href={`/projects/${projectId}/memory`} className="font-semibold underline">智能记忆重建索引</Link>。</span>
        : "已保存；本次切换只影响后续任务，历史结果和向量索引保留。");
    } catch (saveError) { setMessage(saveError instanceof Error ? saveError.message : "路由保存失败"); }
    finally { setPending(false); }
  }

  const activePreview = previewForKey === targetKey ? preview : null;
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="font-semibold">{operationInfo[operation].title}</h3><p className="mt-2 min-h-12 text-xs leading-5 text-slate-500">{operationInfo[operation].description}</p><select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"><option value="">选择已验证供应商</option>{eligible.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {operation === "embedding" ? entry.defaultEmbeddingModelId : operation === "visionExtract" ? entry.defaultVisionModelId : entry.defaultGenerationModelId}</option>)}</select>{operation === "embedding" && deepSeekConfigured ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">DeepSeek 不会出现在这里：当前仅用于自动抽取和问答，不提供项目语义向量。请选 OpenAI、Qwen 或 GLM 的向量模型。</p> : null}{previewPending ? <p className="mt-3 text-xs text-slate-400">正在检查切换影响…</p> : null}{previewError ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{previewError}</p> : null}{activePreview?.impact.onlyFutureRuns ? <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">只影响后续任务；历史结果和向量索引保留。</p> : null}{activePreview?.impact.indexInvalidated ? <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900"><p>当前索引将变为不兼容，语义搜索、RAG 和项目智能体会暂停。</p>{activePreview.impact.activeIndex ? <p className="mt-1 text-amber-800">旧索引：{activePreview.impact.activeIndex.providerName} · {activePreview.impact.activeIndex.modelId} · {activePreview.impact.activeIndex.dimensions} 维</p> : null}<p className="mt-1 text-amber-800">新配置：{provider?.name ?? "所选供应商"} · {target?.modelId ?? "所选模型"} · {target?.embeddingDimensions ?? "未知"} 维</p><label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={acknowledgeIndexRebuild} onChange={(event) => setAcknowledgeIndexRebuild(event.target.checked)} className="mt-1" /><span>我确认保存后前往智能记忆重建索引</span></label></div> : null}<button type="button" onClick={() => void save()} disabled={pending || previewPending || !activePreview || Boolean(previewError) || Boolean(activePreview?.impact.requiresIndexRebuildAcknowledgement && !acknowledgeIndexRebuild)} className="mt-3 w-full rounded-xl bg-slate-950 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{pending ? "保存中…" : current ? "更新路由" : "保存路由"}</button>{message ? <p role="status" className="mt-2 text-xs text-slate-500">{message}</p> : null}</article>;
}

function RepositorySection({ projectId, repositories, credentialSuffix, onReload }: { projectId: string; repositories: RepositoryLink[]; credentialSuffix: string | null; onReload: () => Promise<void> }) {
  const [owner, setOwner] = useState(""); const [repository, setRepository] = useState(""); const [token, setToken] = useState(""); const [trackedBranch, setTrackedBranch] = useState("main"); const [role, setRole] = useState("application"); const [includeRoots, setIncludeRoots] = useState("src"); const [markdownPaths, setMarkdownPaths] = useState("");
  const [codeEnabled, setCodeEnabled] = useState(true); const [readmeEnabled, setReadmeEnabled] = useState(true); const [issuesEnabled, setIssuesEnabled] = useState(false); const [pullRequestsEnabled, setPullRequestsEnabled] = useState(false); const [releasesEnabled, setReleasesEnabled] = useState(true); const [required, setRequired] = useState(true);
  const [pending, setPending] = useState(false); const [activeTask, setActiveTask] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  async function connect(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/repositories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, repository, ...(token ? { token } : {}), role, requiredForProjectSnapshot: required, trackedBranch, codeEnabled, metadataEnabled: true, readmeEnabled, markdownPaths: splitList(markdownPaths), issuesEnabled, pullRequestsEnabled, releasesEnabled, includeRoots: splitList(includeRoots), softExcludePatterns: ["vendor", "node_modules", "build", "dist", "coverage", "generated", "minified", "source_map", "lockfile"] }) }); if (!response.ok) throw new Error(await readError(response, "仓库连接失败")); setToken(""); setOwner(""); setRepository(""); setMessage("仓库已验证并连接"); await onReload(); } catch (connectError) { setMessage(connectError instanceof Error ? connectError.message : "仓库连接失败"); } finally { setPending(false); } }
  async function runTask(path: string, body: object, key: string) { setActiveTask(key); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/repositories/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, clientKey: crypto.randomUUID() }) }); if (!response.ok) throw new Error(await readError(response, "仓库任务失败")); const payload = await response.json() as { job?: Job }; const result = payload.job?.result as GitHubJobResult | null | undefined; const hasWarning = Boolean(result?.warning || result?.warnings?.length); if (payload.job?.status === "unknown") setMessage("任务结果未知，未确认是否发布；请在任务详情中协调确认，系统不会自动重试。 "); else if (payload.job?.kind === "githubProjectSync" && result?.syncRunId) setMessage(`项目同步已结束：${result.status ?? payload.job.status}${hasWarning ? "（含未完成目标，请查看详情）" : ""}。可在下方任务列表打开同步详情。`); else if (payload.job?.status === "failed") setMessage(`任务未完成：${payload.job.failureCode ?? "仓库任务失败"}`); else if (payload.job?.status === "succeeded" && hasWarning) setMessage("任务已完成，但部分可选仓库未完成；已完成内容按原子规则发布。 "); else if (payload.job?.status === "succeeded") setMessage("任务已完成，结果已原子发布"); else setMessage("任务仍在处理中，请查看任务状态"); await onReload(); } catch (taskError) { setMessage(taskError instanceof Error ? taskError.message : "仓库任务失败"); } finally { setActiveTask(null); } }
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">GitHub connector</p><h2 className="mt-2 text-2xl font-semibold">多仓库项目来源</h2><p className="mt-2 text-sm leading-6 text-slate-500">使用只读 fine-grained PAT。凭据{credentialSuffix ? `已保存（尾号 ${credentialSuffix}）` : "尚未配置"}；扫描过程中不会写入 GitHub。</p></div>{repositories.some((entry) => entry.status === "active" && entry.eligible && (entry.config.codeEnabled || entry.config.metadataEnabled || entry.config.readmeEnabled || entry.config.markdownEnabled || entry.config.issuesEnabled || entry.config.pullRequestsEnabled || entry.config.releasesEnabled)) ? <button type="button" onClick={() => void runTask("sync", {}, "sync")} disabled={activeTask !== null} className="rounded-xl bg-indigo-600 px-5 py-3 text-xs font-semibold text-white disabled:opacity-50">{activeTask === "sync" ? "同步与发布中…" : "一键同步全部已启用内容"}</button> : null}</div><div className="mt-7 grid gap-7 lg:grid-cols-[0.75fr_1.25fr]"><form onSubmit={connect} className="rounded-2xl bg-slate-950 p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Connect repository</p><h3 className="mt-2 text-xl font-semibold">连接一个仓库</h3><div className="mt-5 grid grid-cols-2 gap-3"><DarkField label="Owner"><input value={owner} onChange={(event) => setOwner(event.target.value)} required className="control-dark" /></DarkField><DarkField label="Repository"><input value={repository} onChange={(event) => setRepository(event.target.value)} required className="control-dark" /></DarkField></div><DarkField label={credentialSuffix ? "替换 PAT（可选）" : "Fine-grained PAT"}><input type="password" value={token} onChange={(event) => setToken(event.target.value)} required={!credentialSuffix} autoComplete="new-password" className="control-dark" /></DarkField><div className="grid grid-cols-2 gap-3"><DarkField label="跟踪分支"><input value={trackedBranch} onChange={(event) => setTrackedBranch(event.target.value)} required className="control-dark" /></DarkField><DarkField label="仓库角色"><select value={role} onChange={(event) => setRole(event.target.value)} className="control-dark"><option value="primary">主仓库</option><option value="application">应用</option><option value="infrastructure">基础设施</option><option value="library">库</option><option value="documentation">文档</option><option value="other">其他</option></select></DarkField></div><DarkField label="代码扫描根目录（逗号或换行）"><textarea value={includeRoots} onChange={(event) => setIncludeRoots(event.target.value)} rows={2} required className="control-dark" /></DarkField><DarkField label="额外 Markdown 路径（可选）"><textarea value={markdownPaths} onChange={(event) => setMarkdownPaths(event.target.value)} rows={2} className="control-dark" /></DarkField><div className="mt-5 grid grid-cols-2 gap-2 text-xs text-slate-300"><Check label="代码" value={codeEnabled} set={setCodeEnabled} /><Check label="README" value={readmeEnabled} set={setReadmeEnabled} /><Check label="Issues" value={issuesEnabled} set={setIssuesEnabled} /><Check label="Pull Requests" value={pullRequestsEnabled} set={setPullRequestsEnabled} /><Check label="Releases" value={releasesEnabled} set={setReleasesEnabled} /><Check label="项目快照必需" value={required} set={setRequired} /></div><button disabled={pending} className="mt-6 w-full rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50">{pending ? "验证并连接中…" : "验证并连接仓库"}</button><style jsx>{`.control-dark{margin-top:.4rem;width:100%;border-radius:.75rem;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.1);padding:.7rem .8rem;font-size:.8rem;color:white;outline:none}.control-dark option{color:#0f172a}`}</style></form><div>{repositories.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-sm text-slate-500">尚未连接仓库。一个项目可以持续添加多个仓库。</div> : <div className="space-y-4">{repositories.map((link) => <article key={link.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{link.repository.currentFullName}</h3><p className="mt-1 text-xs text-slate-500">{link.config.role} · {link.config.trackedRef} · {link.repository.private ? "私有" : "公开"}</p></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${link.eligible ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{link.eligible ? "可扫描" : link.status}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">范围：{link.config.includeRoots.join("、")} · 最近验证 {formatDate(link.repository.lastVerifiedAt)}</p><div className="mt-4 flex gap-2">{link.config.metadataEnabled || link.config.readmeEnabled || link.config.markdownEnabled || link.config.issuesEnabled || link.config.pullRequestsEnabled || link.config.releasesEnabled ? <button type="button" onClick={() => void runTask("materials", { linkId: link.id }, link.id)} disabled={activeTask !== null || !link.eligible} className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-40">{activeTask === link.id ? "同步中…" : "同步仓库资料"}</button> : null}</div></article>)}</div>}</div></div>{message ? <p role="status" className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}</section>;
}

function DarkField({ label, children }: { label: string; children: ReactNode }) { return <label className="mt-4 block text-xs font-medium text-slate-300">{label}{children}</label>; }
function Check({ label, value, set }: { label: string; value: boolean; set: (value: boolean) => void }) { return <label className="flex items-center gap-2"><input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} /> {label}</label>; }

function JobSection({ projectId, jobs, onReload }: { projectId: string; jobs: Job[]; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, [jobs]);
  async function act(job: Job, action: "reconcile" | "cancel") {
    setPending(`${job.id}:${action}`); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/jobs/${job.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(await readError(response, "任务操作失败"));
      await onReload();
      setMessage(action === "cancel" ? "任务已取消。" : "任务已协调为未知结果，系统不会自动重试。重新运行需重新确认。");
    } catch (actionError) {
      setMessage(actionError instanceof Error ? actionError.message : "任务操作失败");
    } finally {
      setPending(null);
    }
  }
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-5"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Recoverable jobs</p><h2 className="mt-2 text-2xl font-semibold">最近任务</h2><p className="mt-2 text-sm leading-6 text-slate-500">每次执行都有独立租约与 attempt。未知结果不会自动重试，避免重复调用模型。</p></div>{jobs.length === 0 ? <p className="mt-6 text-sm text-slate-500">还没有页面任务。</p> : <div className="mt-5 divide-y divide-slate-100">{jobs.map((job) => { const attempt = job.attempts[0]; const result = job.result as GitHubJobResult | null; const expired = now !== null && job.status === "running" && attempt !== undefined && new Date(attempt.leaseExpiresAt).getTime() <= now; const canCancel = job.status === "queued" || job.status === "waitingConsent"; const canReconcile = expired || (job.kind === "githubProjectSync" && job.status === "unknown" && job.reconciliationRequired); return <div key={job.id} className="flex flex-wrap items-start justify-between gap-4 py-4"><div className="min-w-0"><p className="text-sm font-semibold text-slate-700">{job.kind}</p><p className="mt-1 text-xs text-slate-400">{formatDate(job.createdAt)} · {job.stage}{attempt ? ` · attempt #${attempt.attemptNumber}` : ""}</p>{job.kind === "githubProjectSync" && result?.syncRunId ? <p className="mt-2 text-xs text-slate-500">变更：新增 {result.counts?.added ?? 0} · 更新 {result.counts?.updated ?? 0} · 删除 {result.counts?.deleted ?? 0} · 保留 {result.counts?.withheld ?? 0} · <Link href={`/projects/${projectId}/github-syncs/${result.syncRunId}`} className="font-semibold text-indigo-700 underline">查看同步详情</Link></p> : null}{job.kind === "githubProjectSync" && result?.warnings?.length ? <p className="mt-2 text-xs leading-5 text-amber-700">提示：{result.warnings.join(" · ")}</p> : null}{job.status === "unknown" ? <p className="mt-2 text-xs leading-5 text-orange-700">{job.kind === "githubProjectSync" && job.reconciliationRequired ? "外部读取结果未知；协调确认不会重试，也不会调用 GitHub，只记录放弃本次未知结果。" : "外部调用结果未知，禁止自动重试；重新运行需重新确认。"}</p> : null}{expired ? <p className="mt-2 text-xs leading-5 text-amber-700">执行租约已过期，可手动协调确认。</p> : null}</div><div className="flex flex-wrap items-center justify-end gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : job.status === "unknown" ? "bg-orange-50 text-orange-700" : job.status === "cancelled" ? "bg-slate-100 text-slate-600" : "bg-indigo-50 text-indigo-700"}`}>{jobStatusLabels[job.status]}{job.failureCode ? ` · ${job.failureCode}` : ""}</span>{canCancel ? <button type="button" onClick={() => void act(job, "cancel")} disabled={pending !== null} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">{pending === `${job.id}:cancel` ? "取消中…" : "取消"}</button> : null}{canReconcile ? <button type="button" onClick={() => void act(job, "reconcile")} disabled={pending !== null} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40">{pending === `${job.id}:reconcile` ? "协调中…" : job.kind === "githubProjectSync" && job.status === "unknown" ? "协调确认/关闭未知结果" : "协调确认"}</button> : null}</div></div>; })}</div>}{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">{message}</p> : null}</section>;
}
