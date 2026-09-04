"use client";

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { projectJobFailurePresentation } from "@/lib/project-job-failure";

type RepositoryConnection = {
  id: string;
  name: string;
  providerKind: string;
  transport: string;
};
type Repository = {
  id: string;
  role: string;
  trackedRef: string;
  requiredForProjectSnapshot: boolean;
  codeEnabled: boolean;
  metadataEnabled: boolean;
  includeRoots: string[];
  softExcludePatterns: string[];
  status: "active" | "disabled" | "unlinked";
  disabledAt: string | null;
  repository: {
    repositoryPath: string;
    displayName: string;
    webUrl: string | null;
    connection: RepositoryConnection;
  };
  snapshotPointer: null | {
    publishedAt: string;
    snapshot: { id: string; frozenCommitSha: string; fileCount: number; decodedTextBytes: number; completedAt: string };
  };
  snapshots: Array<{ id: string; status: string; failureCode: string | null; startedAt: string; completedAt: string | null }>;
};
type ScanPolicy = { maxScannedFiles: number; maxFileBytes: number; maxTotalBytes: number };

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { code?: unknown; message?: string } };
    const failure = projectJobFailurePresentation(payload.error?.code);
    if (failure.code) return `${failure.summary} ${failure.action}（错误代码：${failure.code}）`;
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function bytesLabel(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function ProjectRepositoriesClient({ username, projectId }: { username: string; projectId: string }) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [scanPolicy, setScanPolicy] = useState<ScanPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const repositoryResponse = await fetch(`/api/projects/${projectId}/git-repositories`, { cache: "no-store" });
      if (!repositoryResponse.ok) throw new Error(await responseError(repositoryResponse, "项目仓库加载失败"));
      const repositoryPayload = await repositoryResponse.json() as { repositories: Repository[]; scanPolicy?: ScanPolicy };
      setRepositories(repositoryPayload.repositories);
      if (repositoryPayload.scanPolicy) setScanPolicy(repositoryPayload.scanPolicy);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目仓库加载失败");
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
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="repositories" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectMaterialsParentLink projectId={projectId} /></div>
        <section className="flex flex-col justify-between gap-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm lg:flex-row lg:items-end lg:p-9">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Repository memory</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目代码仓库</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">这里展示当前项目已经关联的代码仓库。个人 Git 连接与项目委托正在改造，当前不能新增仓库；已有仓库仍可查看、同步和停用。每次扫描会先冻结分支提交，完整读取允许范围，再一次性发布新快照。</p></div>
          <div className="grid shrink-0 grid-cols-3 gap-3 text-center text-xs"><Metric label="仓库" value={String(repositories.filter((item) => item.status === "active").length)} /><Metric label="已发布" value={String(repositories.filter((item) => item.snapshotPointer).length)} /><Metric label="连接" value={String(new Set(repositories.map((item) => item.repository.connection.id)).size)} /></div>
        </section>
        {scanPolicy ? <aside className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm leading-6 text-indigo-900"><strong className="font-semibold">当前扫描限制：</strong>范围内最多 {scanPolicy.maxScannedFiles.toLocaleString("zh-CN")} 个文本文件，单文件最多 {bytesLabel(scanPolicy.maxFileBytes)}，候选文本合计最多 {bytesLabel(scanPolicy.maxTotalBytes)}。扫描范围沿用现有关联配置；依赖、构建产物和 vendor 目录会自动排除。</aside> : null}
        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <div className="mt-8 grid gap-7 xl:grid-cols-[.78fr_1.22fr]">
          <section className="h-fit rounded-3xl border border-indigo-200 bg-indigo-50/70 p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Repository access</p><h2 className="mt-2 text-2xl font-semibold">个人 Git 与项目委托改造中</h2><p className="mt-3 text-sm leading-7 text-slate-600">当前不能从项目页新增仓库或选择全局 Git 连接。已有只读项目仓库仍可查看、同步和停用；后续将支持用户私有 Git 配置，并由项目明确委托使用。</p></section>
          <section>
            <div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Linked repositories</p><h2 className="mt-2 text-2xl font-semibold">仓库清单</h2></div><span className="text-xs text-slate-400">{loading ? "读取中…" : `${repositories.length} 个`}</span></div>
            <div className="space-y-4">{!loading && repositories.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">当前还没有关联仓库。个人 Git 连接与项目委托正在改造，当前不能新增；已有仓库会在此展示并保留既有操作。</div> : repositories.map((repository) => <RepositoryCard key={repository.id} projectId={projectId} repository={repository} onReload={reload} />)}</div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-20 rounded-2xl bg-slate-50 px-4 py-3"><strong className="block text-xl text-slate-900">{value}</strong><span className="mt-1 block text-slate-500">{label}</span></div>;
}

function RepositoryCard({ projectId, repository, onReload }: { projectId: string; repository: Repository; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const snapshot = repository.snapshotPointer?.snapshot;
  const latestFailure = projectJobFailurePresentation(repository.snapshots[0]?.failureCode);

  async function sync() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/git-repositories/${repository.id}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientKey: `web-${crypto.randomUUID()}` }) });
      if (!response.ok) throw new Error(await responseError(response, "仓库扫描失败"));
      const payload = await response.json() as { job: { status: string; failureCode: string | null; result?: { fileCount?: number; commitSha?: string } } };
      if (payload.job.status === "succeeded") {
        setMessage(`扫描完成，发布 ${payload.job.result?.fileCount ?? 0} 个文本文件。`);
      } else if (payload.job.status === "failed") {
        const failure = projectJobFailurePresentation(payload.job.failureCode);
        setMessage(`扫描失败：${failure.summary} ${failure.action}${failure.code ? `（错误代码：${failure.code}）` : ""}`);
      } else {
        setMessage(`任务状态：${payload.job.status}`);
      }
      await onReload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "仓库扫描失败");
    } finally {
      setPending(false);
    }
  }

  async function disable() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/git-repositories/${repository.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "停用仓库失败"));
      setMessage("仓库已停用，历史快照和引用继续保留。");
      await onReload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "停用仓库失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className={`rounded-3xl border bg-white p-6 shadow-sm ${repository.status === "active" ? "border-slate-200" : "border-slate-200 opacity-70"}`}>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{repository.repository.displayName}</h3><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">{repository.repository.connection.providerKind}</span></div><p className="mt-2 text-xs text-slate-500">{repository.repository.connection.name} · {repository.repository.repositoryPath} · {repository.trackedRef}</p></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${repository.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{repository.status === "active" ? "已启用" : "已停用"}</span></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><Metric label="当前提交" value={snapshot?.frozenCommitSha.slice(0, 10) ?? "未扫描"} /><Metric label="文本文件" value={snapshot ? String(snapshot.fileCount) : "—"} /><Metric label="已发布文本" value={snapshot ? bytesLabel(snapshot.decodedTextBytes) : "—"} /></div>
      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600"><p>扫描目录：{repository.includeRoots.join("、")}</p><p>项目快照：{repository.requiredForProjectSnapshot ? "必需" : "可选"} · 角色：{repository.role}</p>{snapshot ? <p>发布时间：{new Date(repository.snapshotPointer!.publishedAt).toLocaleString("zh-CN")}</p> : null}{repository.snapshots[0]?.status === "failed" ? <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700"><p className="font-semibold">最近扫描失败</p><p className="mt-1">{latestFailure.summary}</p><p className="mt-1">建议：{latestFailure.action}</p>{latestFailure.code ? <p className="mt-1 font-mono text-[11px] [overflow-wrap:anywhere]">错误代码：{latestFailure.code}</p> : null}</div> : null}</div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs leading-5 text-slate-600">{message ?? "扫描只读取当前分支，不会 checkout 子模块、执行钩子或写入远端。"}</p>{repository.status === "active" ? <div className="flex gap-2"><button onClick={() => void disable()} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">停用</button><button onClick={() => void sync()} disabled={pending} className="rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending ? "处理中…" : snapshot ? "增量刷新" : "首次扫描"}</button></div> : null}</div>
    </article>
  );
}
