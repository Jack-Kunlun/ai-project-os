"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { ProjectIntelligenceParentLink } from "@/components/project-parent-link";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";
import { jobStatusLabels, type JobAttemptSummary } from "@/lib/workspace-summary";

type Provider = {
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  status: "configured" | "verified" | "error";
  defaultGenerationModelId: string | null;
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
    const payload = await response.json() as { error?: { code?: unknown; message?: string } };
    const code = payload.error?.code;
    if (typeof code === "string" && /^(?:GIT|GITHUB|PROJECT_GITHUB_SYNC)_/u.test(code)) {
      const failure = projectJobFailurePresentation(code);
      if (failure.code) return `${failure.summary} ${failure.action}（错误代码：${failure.code}）`;
    }
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectControlClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [routes, setRoutes] = useState<AiRoute[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, routeResponse, jobResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/ai-routes`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !routeResponse.ok || !jobResponse.ok) {
        const failed = [projectResponse, routeResponse, jobResponse].find((response) => !response.ok)!;
        throw new Error(await readError(failed, "控制台加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const routePayload = await routeResponse.json() as { providers: Provider[]; routes: AiRoute[] };
      const jobPayload = await jobResponse.json() as { jobs: Job[] };
      setProjectName(projectPayload.project.name);
      setProviders(routePayload.providers);
      setRoutes(routePayload.routes);
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
        <div className="mb-5"><ProjectIntelligenceParentLink projectId={projectId} /></div>
        <section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Control plane</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">选择每项 AI 能力使用的供应商。旧项目级 GitHub 连接和自动同步继续冻结；一次性手动只读委托已迁移到<Link href={`/projects/${projectId}/repositories`} className="font-semibold text-indigo-700 underline">项目 Git 页面</Link>，需要个人连接与项目双重授权。</p></section>
        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {loading ? <div className="h-40 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <AiRouteSection projectId={projectId} providers={providers} routes={routes} onChanged={setRoutes} />
            <FrozenRepositorySection projectId={projectId} />
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
      {providers.length === 0 ? <p className="mt-6 rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-800">当前没有可用的项目模型路由，请联系系统管理员完成平台模型配置，或由工作区 Owner/Admin 配置有效的工作区连接。</p> : <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{(["embedding", "visionExtract", "autoExtract", "generateWithContext"] as const).map((operation) => <RouteCard key={operation} operation={operation} projectId={projectId} providers={providers} current={routes.find((route) => route.operation === operation)} onSaved={(route) => onChanged([...routes.filter((item) => item.operation !== operation), route])} />)}</div>}
    </section>
  );
}

function RouteCard({ operation, projectId, providers, current, onSaved }: { operation: keyof typeof operationInfo; projectId: string; providers: Provider[]; current?: AiRoute; onSaved: (route: AiRoute) => void }) {
  const eligible = useMemo(() => providers.filter((provider) => {
    if (provider.status !== "verified") return false;
    if (operation === "embedding") return provider.defaultEmbeddingModelId !== null;
    if (operation === "visionExtract") return provider.defaultVisionModelId !== null;
    return provider.defaultGenerationModelId !== null;
  }), [providers, operation]);
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
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="font-semibold">{operationInfo[operation].title}</h3><p className="mt-2 min-h-12 text-xs leading-5 text-slate-500">{operationInfo[operation].description}</p><select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"><option value="">选择已验证供应商</option>{eligible.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {operation === "embedding" ? entry.defaultEmbeddingModelId : operation === "visionExtract" ? entry.defaultVisionModelId : entry.defaultGenerationModelId}</option>)}</select>{operation === "embedding" && deepSeekConfigured ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">DeepSeek 不会出现在这里：当前仅用于自动抽取和问答，不提供项目语义向量。请选 OpenAI、Qwen 或 GLM 的向量模型。</p> : null}{previewPending ? <p className="mt-3 text-xs text-slate-400">正在检查切换影响…</p> : null}{previewError ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{previewError}</p> : null}{activePreview?.impact.onlyFutureRuns ? <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">只影响后续任务；历史结果和向量索引保留。</p> : null}{activePreview?.impact.indexInvalidated ? <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900"><p>当前索引将变为不兼容，语义搜索、RAG 和项目智能体会暂停。</p>{activePreview.impact.activeIndex ? <p className="mt-1 text-amber-800">旧索引：{activePreview.impact.activeIndex.providerName} · {activePreview.impact.activeIndex.modelId} · {activePreview.impact.activeIndex.dimensions} 维</p> : null}<p className="mt-1 text-amber-800">新配置：{provider?.name ?? "所选供应商"} · {target?.modelId ?? "所选模型"} · {target?.embeddingDimensions ?? "未知"} 维</p><label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={acknowledgeIndexRebuild} onChange={(event) => setAcknowledgeIndexRebuild(event.target.checked)} className="mt-1" /><span>我确认保存后前往智能记忆重建索引</span></label></div> : null}<button type="button" onClick={() => void save()} disabled={pending || previewPending || !activePreview || Boolean(previewError) || Boolean(activePreview?.impact.requiresIndexRebuildAcknowledgement && !acknowledgeIndexRebuild)} className="mt-3 w-full rounded-xl bg-slate-950 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{pending ? "保存中…" : current ? "更新路由" : "保存路由"}</button>{message ? <p role="status" className="mt-2 text-xs text-slate-500">{message}</p> : null}</article>;
}

function FrozenRepositorySection({ projectId }: { projectId: string }) {
  return <section className="mt-8 rounded-3xl border border-amber-200 bg-amber-50 p-7 shadow-sm sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">GitHub connector</p>
    <h2 className="mt-2 text-2xl font-semibold text-slate-950">旧项目仓库自动化已冻结</h2>
    <p className="mt-3 max-w-3xl text-sm leading-6 text-amber-900">
      旧项目级 PAT 连接、自动同步和历史 GitHub 外发仍冻结，当前页面不会接收或发送 PAT，也不会启动仓库同步。一次性手动只读读取请前往<Link href={`/projects/${projectId}/repositories`} className="font-semibold underline">项目 Git 委托</Link>；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。
    </p>
  </section>;
}


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
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-5"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Recoverable jobs</p><h2 className="mt-2 text-2xl font-semibold">最近任务</h2><p className="mt-2 text-sm leading-6 text-slate-500">每次执行都有独立租约与 attempt。未知结果不会自动重试，避免重复调用模型。</p></div>{jobs.length === 0 ? <p className="mt-6 text-sm text-slate-500">还没有页面任务。</p> : <div className="mt-5 divide-y divide-slate-100">{jobs.map((job) => { const attempt = job.attempts[0]; const result = job.result as GitHubJobResult | null; const failure = projectJobFailurePresentation(job.failureCode); const expired = now !== null && job.status === "running" && attempt !== undefined && new Date(attempt.leaseExpiresAt).getTime() <= now; const canCancel = job.status === "queued" || job.status === "waitingConsent"; const canReconcile = expired || (job.kind === "githubProjectSync" && job.status === "unknown" && job.reconciliationRequired); return <div key={job.id} className="flex flex-wrap items-start justify-between gap-4 py-4"><div className="min-w-0"><p className="text-sm font-semibold text-slate-700">{job.kind}</p><p className="mt-1 text-xs text-slate-400">{formatDate(job.createdAt)} · {job.stage}{attempt ? ` · attempt #${attempt.attemptNumber}` : ""}</p>{job.kind === "githubProjectSync" && result?.syncRunId ? <p className="mt-2 text-xs text-slate-500">变更：新增 {result.counts?.added ?? 0} · 更新 {result.counts?.updated ?? 0} · 删除 {result.counts?.deleted ?? 0} · 保留 {result.counts?.withheld ?? 0} · <Link href={`/projects/${projectId}/github-syncs/${result.syncRunId}`} className="font-semibold text-indigo-700 underline">查看同步详情</Link></p> : null}{job.kind === "githubProjectSync" && result?.warnings?.length ? <p className="mt-2 text-xs leading-5 text-amber-700">提示：{result.warnings.join(" · ")}</p> : null}{job.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-700">{failure.summary} {failure.action}</p> : null}{job.status === "unknown" ? <p className="mt-2 text-xs leading-5 text-orange-700">{job.kind === "githubProjectSync" && job.reconciliationRequired ? "外部读取结果未知；协调确认不会重试，也不会调用 GitHub，只记录放弃本次未知结果。" : "外部调用结果未知，禁止自动重试；重新运行需重新确认。"}</p> : null}{expired ? <p className="mt-2 text-xs leading-5 text-amber-700">执行租约已过期，可手动协调确认。</p> : null}</div><div className="flex flex-wrap items-center justify-end gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : job.status === "unknown" ? "bg-orange-50 text-orange-700" : job.status === "cancelled" ? "bg-slate-100 text-slate-600" : "bg-indigo-50 text-indigo-700"}`}>{jobStatusLabels[job.status]}{failure.code ? ` · ${failure.code}` : ""}</span>{canCancel ? <button type="button" onClick={() => void act(job, "cancel")} disabled={pending !== null} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">{pending === `${job.id}:cancel` ? "取消中…" : "取消"}</button> : null}{canReconcile ? <button type="button" onClick={() => void act(job, "reconcile")} disabled={pending !== null} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40">{pending === `${job.id}:reconcile` ? "协调中…" : job.kind === "githubProjectSync" && job.status === "unknown" ? "协调确认/关闭未知结果" : "协调确认"}</button> : null}</div></div>; })}</div>}{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">{message}</p> : null}</section>;
}
