"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

type Provider = {
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  status: "configured" | "verified" | "error";
  defaultGenerationModelId: string;
  defaultEmbeddingModelId: string | null;
  embeddingDimensions: number | null;
};
type AiRoute = {
  operation: "embedding" | "autoExtract" | "generateWithContext";
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
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
  kind: "githubScan" | "githubMaterialSync" | "memoryIndex" | "autoExtract" | "ragAnswer";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
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

export function ProjectControlClient() {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [routes, setRoutes] = useState<AiRoute[]>([]);
  const [repositories, setRepositories] = useState<RepositoryLink[]>([]);
  const [credentialSuffix, setCredentialSuffix] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-7">
          <Link href="/" className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold text-white">OS</span><span><span className="block text-sm font-semibold tracking-[0.16em]">AI PROJECT OS</span><span className="block text-xs text-slate-500">项目智能控制台 · V2.0</span></span></Link>
          <div className="flex gap-2"><Link href={`/projects/${projectId}`} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600">资料与条目</Link><Link href={`/projects/${projectId}/memory`} className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white">智能记忆</Link></div>
        </header>

        <section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Control plane</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">选择每项 AI 能力使用的供应商，并在页面连接多个 GitHub 仓库。仓库读取始终冻结到明确 commit，扫描结果按仓库级原子发布。</p></section>
        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {loading ? <div className="h-40 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <AiRouteSection projectId={projectId} providers={providers} routes={routes} onChanged={setRoutes} />
            <RepositorySection projectId={projectId} repositories={repositories} credentialSuffix={credentialSuffix} onReload={reload} />
            <JobSection jobs={jobs} />
          </>
        )}
      </div>
    </main>
  );
}

const operationInfo = {
  embedding: { title: "语义向量", description: "为项目资料和仓库内容建立语义索引。" },
  autoExtract: { title: "自动抽取", description: "从原始资料抽取待人工审核的决策、进展、问题和风险。" },
  generateWithContext: { title: "引用式问答", description: "只基于检索到的项目证据生成带引用回答。" },
} as const;

function AiRouteSection({ projectId, providers, routes, onChanged }: { projectId: string; providers: Provider[]; routes: AiRoute[]; onChanged: (routes: AiRoute[]) => void }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
      <div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Capability routing</p><h2 className="mt-2 text-2xl font-semibold">项目模型路由</h2><p className="mt-2 text-sm leading-6 text-slate-500">仅能选择已通过连接测试的供应商。生成与向量可以分别使用不同国内外服务。</p></div>
      {providers.length === 0 ? <p className="mt-6 rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-800">还没有可用供应商。请先到 <Link href="/settings" className="font-semibold underline">模型与系统设置</Link> 添加并测试连接。</p> : <div className="mt-6 grid gap-4 lg:grid-cols-3">{(["embedding", "autoExtract", "generateWithContext"] as const).map((operation) => <RouteCard key={operation} operation={operation} projectId={projectId} providers={providers} current={routes.find((route) => route.operation === operation)} onSaved={(route) => onChanged([...routes.filter((item) => item.operation !== operation), route])} />)}</div>}
    </section>
  );
}

function RouteCard({ operation, projectId, providers, current, onSaved }: { operation: keyof typeof operationInfo; projectId: string; providers: Provider[]; current?: AiRoute; onSaved: (route: AiRoute) => void }) {
  const eligible = useMemo(() => providers.filter((provider) => provider.status === "verified" && (operation !== "embedding" || provider.defaultEmbeddingModelId !== null)), [providers, operation]);
  const [providerId, setProviderId] = useState(current?.providerConnectionId ?? eligible[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const provider = eligible.find((entry) => entry.id === providerId);

  async function save() {
    if (!provider) return;
    setPending(true); setMessage(null);
    try {
      const isEmbedding = operation === "embedding";
      const response = await fetch(`/api/projects/${projectId}/ai-routes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, providerConnectionId: provider.id, modelId: isEmbedding ? provider.defaultEmbeddingModelId : provider.defaultGenerationModelId, embeddingDimensions: isEmbedding ? provider.embeddingDimensions : null, maxOutputTokens: isEmbedding ? 128 : 2048 }) });
      if (!response.ok) throw new Error(await readError(response, "路由保存失败"));
      onSaved((await response.json() as { route: AiRoute }).route);
      setMessage("已保存");
    } catch (saveError) { setMessage(saveError instanceof Error ? saveError.message : "路由保存失败"); }
    finally { setPending(false); }
  }

  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><h3 className="font-semibold">{operationInfo[operation].title}</h3><p className="mt-2 min-h-12 text-xs leading-5 text-slate-500">{operationInfo[operation].description}</p><select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"><option value="">选择已验证供应商</option>{eligible.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {operation === "embedding" ? entry.defaultEmbeddingModelId : entry.defaultGenerationModelId}</option>)}</select><button type="button" onClick={() => void save()} disabled={pending || !provider} className="mt-3 w-full rounded-xl bg-slate-950 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{pending ? "保存中…" : current ? "更新路由" : "保存路由"}</button>{message ? <p className="mt-2 text-xs text-slate-500">{message}</p> : null}</article>;
}

function RepositorySection({ projectId, repositories, credentialSuffix, onReload }: { projectId: string; repositories: RepositoryLink[]; credentialSuffix: string | null; onReload: () => Promise<void> }) {
  const [owner, setOwner] = useState(""); const [repository, setRepository] = useState(""); const [token, setToken] = useState(""); const [trackedBranch, setTrackedBranch] = useState("main"); const [role, setRole] = useState("application"); const [includeRoots, setIncludeRoots] = useState("src"); const [markdownPaths, setMarkdownPaths] = useState("");
  const [codeEnabled, setCodeEnabled] = useState(true); const [readmeEnabled, setReadmeEnabled] = useState(true); const [issuesEnabled, setIssuesEnabled] = useState(false); const [pullRequestsEnabled, setPullRequestsEnabled] = useState(false); const [releasesEnabled, setReleasesEnabled] = useState(true); const [required, setRequired] = useState(true);
  const [pending, setPending] = useState(false); const [activeTask, setActiveTask] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  async function connect(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/repositories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, repository, ...(token ? { token } : {}), role, requiredForProjectSnapshot: required, trackedBranch, codeEnabled, metadataEnabled: true, readmeEnabled, markdownPaths: splitList(markdownPaths), issuesEnabled, pullRequestsEnabled, releasesEnabled, includeRoots: splitList(includeRoots), softExcludePatterns: ["vendor", "node_modules", "build", "dist", "coverage", "generated", "minified", "source_map", "lockfile"] }) }); if (!response.ok) throw new Error(await readError(response, "仓库连接失败")); setToken(""); setOwner(""); setRepository(""); setMessage("仓库已验证并连接"); await onReload(); } catch (connectError) { setMessage(connectError instanceof Error ? connectError.message : "仓库连接失败"); } finally { setPending(false); } }
  async function runTask(path: string, body: object, key: string) { setActiveTask(key); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/repositories/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, clientKey: crypto.randomUUID() }) }); if (!response.ok) throw new Error(await readError(response, "仓库任务失败")); setMessage("任务已完成，结果已原子发布"); await onReload(); } catch (taskError) { setMessage(taskError instanceof Error ? taskError.message : "仓库任务失败"); } finally { setActiveTask(null); } }
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">GitHub connector</p><h2 className="mt-2 text-2xl font-semibold">多仓库项目来源</h2><p className="mt-2 text-sm leading-6 text-slate-500">使用只读 fine-grained PAT。凭据{credentialSuffix ? `已保存（尾号 ${credentialSuffix}）` : "尚未配置"}；扫描过程中不会写入 GitHub。</p></div>{repositories.some((entry) => entry.status === "active" && entry.config.codeEnabled) ? <button type="button" onClick={() => void runTask("scan", {}, "scan")} disabled={activeTask !== null} className="rounded-xl bg-indigo-600 px-5 py-3 text-xs font-semibold text-white disabled:opacity-50">{activeTask === "scan" ? "扫描与发布中…" : "扫描全部代码仓库"}</button> : null}</div><div className="mt-7 grid gap-7 lg:grid-cols-[0.75fr_1.25fr]"><form onSubmit={connect} className="rounded-2xl bg-slate-950 p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Connect repository</p><h3 className="mt-2 text-xl font-semibold">连接一个仓库</h3><div className="mt-5 grid grid-cols-2 gap-3"><DarkField label="Owner"><input value={owner} onChange={(event) => setOwner(event.target.value)} required className="control-dark" /></DarkField><DarkField label="Repository"><input value={repository} onChange={(event) => setRepository(event.target.value)} required className="control-dark" /></DarkField></div><DarkField label={credentialSuffix ? "替换 PAT（可选）" : "Fine-grained PAT"}><input type="password" value={token} onChange={(event) => setToken(event.target.value)} required={!credentialSuffix} autoComplete="new-password" className="control-dark" /></DarkField><div className="grid grid-cols-2 gap-3"><DarkField label="跟踪分支"><input value={trackedBranch} onChange={(event) => setTrackedBranch(event.target.value)} required className="control-dark" /></DarkField><DarkField label="仓库角色"><select value={role} onChange={(event) => setRole(event.target.value)} className="control-dark"><option value="primary">主仓库</option><option value="application">应用</option><option value="infrastructure">基础设施</option><option value="library">库</option><option value="documentation">文档</option><option value="other">其他</option></select></DarkField></div><DarkField label="代码扫描根目录（逗号或换行）"><textarea value={includeRoots} onChange={(event) => setIncludeRoots(event.target.value)} rows={2} required className="control-dark" /></DarkField><DarkField label="额外 Markdown 路径（可选）"><textarea value={markdownPaths} onChange={(event) => setMarkdownPaths(event.target.value)} rows={2} className="control-dark" /></DarkField><div className="mt-5 grid grid-cols-2 gap-2 text-xs text-slate-300"><Check label="代码" value={codeEnabled} set={setCodeEnabled} /><Check label="README" value={readmeEnabled} set={setReadmeEnabled} /><Check label="Issues" value={issuesEnabled} set={setIssuesEnabled} /><Check label="Pull Requests" value={pullRequestsEnabled} set={setPullRequestsEnabled} /><Check label="Releases" value={releasesEnabled} set={setReleasesEnabled} /><Check label="项目快照必需" value={required} set={setRequired} /></div><button disabled={pending} className="mt-6 w-full rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50">{pending ? "验证并连接中…" : "验证并连接仓库"}</button><style jsx>{`.control-dark{margin-top:.4rem;width:100%;border-radius:.75rem;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.1);padding:.7rem .8rem;font-size:.8rem;color:white;outline:none}.control-dark option{color:#0f172a}`}</style></form><div>{repositories.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-sm text-slate-500">尚未连接仓库。一个项目可以持续添加多个仓库。</div> : <div className="space-y-4">{repositories.map((link) => <article key={link.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{link.repository.currentFullName}</h3><p className="mt-1 text-xs text-slate-500">{link.config.role} · {link.config.trackedRef} · {link.repository.private ? "私有" : "公开"}</p></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${link.eligible ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{link.eligible ? "可扫描" : link.status}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">范围：{link.config.includeRoots.join("、")} · 最近验证 {formatDate(link.repository.lastVerifiedAt)}</p><div className="mt-4 flex gap-2">{link.config.metadataEnabled || link.config.readmeEnabled || link.config.issuesEnabled || link.config.pullRequestsEnabled || link.config.releasesEnabled ? <button type="button" onClick={() => void runTask("materials", { linkId: link.id }, link.id)} disabled={activeTask !== null || !link.eligible} className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-40">{activeTask === link.id ? "同步中…" : "同步仓库资料"}</button> : null}</div></article>)}</div>}</div></div>{message ? <p role="status" className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}</section>;
}

function DarkField({ label, children }: { label: string; children: ReactNode }) { return <label className="mt-4 block text-xs font-medium text-slate-300">{label}{children}</label>; }
function Check({ label, value, set }: { label: string; value: boolean; set: (value: boolean) => void }) { return <label className="flex items-center gap-2"><input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} /> {label}</label>; }

function JobSection({ jobs }: { jobs: Job[] }) { return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-5"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Durable jobs</p><h2 className="mt-2 text-2xl font-semibold">最近任务</h2></div>{jobs.length === 0 ? <p className="mt-6 text-sm text-slate-500">还没有页面任务。</p> : <div className="mt-5 divide-y divide-slate-100">{jobs.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="text-sm font-semibold text-slate-700">{job.kind}</p><p className="mt-1 text-xs text-slate-400">{formatDate(job.createdAt)} · {job.stage}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : "bg-indigo-50 text-indigo-700"}`}>{job.status}{job.failureCode ? ` · ${job.failureCode}` : ""}</span></div>)}</div>}</section>; }
