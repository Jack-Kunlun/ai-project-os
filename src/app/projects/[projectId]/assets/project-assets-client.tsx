"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ListPagination } from "@/components/list-pagination";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";
import { DEFAULT_UPLOAD_POLICY, type PublicUploadPolicy } from "@/lib/project-assets/policy";

type AssetStatus = "uploaded" | "parsing" | "waitingVision" | "awaitingReview" | "ready" | "failed" | "deleted";
type Segment = {
  id: string;
  ordinal: number;
  locatorLabel: string;
  requiresVision: boolean;
  extractionMethod: "localText" | "localDocument" | "vision";
  contentText: string;
  reviewedText: string | null;
  reviewStatus: "pending" | "accepted" | "dismissed";
  modelId: string | null;
  projectSourceId: string | null;
  providerConnection: null | { id: string; name: string; kind: string };
};
type Asset = {
  id: string;
  displayName: string;
  kind: "text" | "document" | "spreadsheet" | "presentation" | "image";
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  version: null | {
    id: string;
    originalFileName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    failureCode: string | null;
  };
  segments: Segment[];
  latestRun: null | {
    status: string;
    modelId: string | null;
    visionSegmentCount: number;
    failureCode: string | null;
  };
};

type UploadUsage = {
  projectBytes: string;
  activeAssetCount: number;
  retainedObjectCount: number;
  activeUploads: number;
};

const statusLabels: Record<AssetStatus, string> = {
  uploaded: "已上传",
  parsing: "本地解析中",
  waitingVision: "等待图片识别",
  awaitingReview: "等待人工确认",
  ready: "已发布到资料库",
  failed: "解析失败",
  deleted: "已删除",
};
const kindLabels = { text: "文本", document: "文档", spreadsheet: "表格", presentation: "演示文稿", image: "图片" } as const;
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusTone(status: AssetStatus): string {
  if (status === "ready") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "failed") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (status === "waitingVision" || status === "awaitingReview") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

export function ProjectAssetsClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [pagination, setPagination] = useState<ListPaginationState>({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recognizing, setRecognizing] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PublicUploadPolicy>(DEFAULT_UPLOAD_POLICY);
  const [usage, setUsage] = useState<UploadUsage>({ projectBytes: "0", activeAssetCount: 0, retainedObjectCount: 0, activeUploads: 0 });
  const { confirm, dialog } = useAppConfirmDialog();

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, assetsResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/assets?${new URLSearchParams({ page: String(page), pageSize: "10", ...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}), kind: kindFilter, status: statusFilter })}`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !assetsResponse.ok) {
        const failed = !projectResponse.ok ? projectResponse : assetsResponse;
        throw new Error(await readError(failed, "文件资料加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const assetsPayload = await assetsResponse.json() as { assets: Asset[]; pagination: ListPaginationState; policy?: PublicUploadPolicy; usage?: UploadUsage };
      setProjectName(projectPayload.project.name);
      setAssets(assetsPayload.assets);
      setPagination(assetsPayload.pagination);
      if (page > assetsPayload.pagination.totalPages) setPage(assetsPayload.pagination.totalPages);
      if (assetsPayload.policy) setPolicy(assetsPayload.policy);
      if (assetsPayload.usage) setUsage(assetsPayload.usage);
      setEdits((current) => {
        const next = { ...current };
        for (const asset of assetsPayload.assets) {
          for (const segment of asset.segments) next[segment.id] ??= segment.reviewedText ?? segment.contentText;
        }
        return next;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "文件资料加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [deferredSearch, kindFilter, page, projectId, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const pendingCount = useMemo(() => assets.reduce((count, asset) =>
    count + asset.segments.filter((segment) => segment.reviewStatus === "pending" && !segment.requiresVision).length, 0), [assets]);

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    setFiles(selected.slice(0, policy.maxFiles));
    if (selected.length > policy.maxFiles) {
      setMessage(`已只保留前 ${policy.maxFiles} 个文件；单次最多选择 ${policy.maxFiles} 个。`);
    }
    else setMessage(null);
  }

  async function upload() {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    let uploaded = 0;
    const failures: string[] = [];
    const parseFailures: string[] = [];
    for (const file of files) {
      try {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
        if (!response.ok) throw new Error(await readError(response, "上传失败"));
        const payload = await response.json() as { asset?: Asset };
        uploaded += 1;
        if (payload.asset?.status === "failed") parseFailures.push(file.name);
      } catch (uploadError) {
        failures.push(`${file.name}：${uploadError instanceof Error ? uploadError.message : "上传失败"}`);
      }
    }
    setFiles([]);
    setMessage(failures.length === 0
      ? parseFailures.length === 0
        ? `已上传并解析 ${uploaded} 个文件。`
        : `已保存 ${uploaded} 个文件，其中 ${parseFailures.length} 个本地解析失败，可在文件卡片中重试：${parseFailures.join("、")}`
      : `成功保存 ${uploaded} 个，上传失败 ${failures.length} 个：${failures.join("；")}`);
    await reload();
    setUploading(false);
  }

  async function recognize(asset: Asset) {
    if (!consents[asset.id]) return;
    setRecognizing(asset.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}/recognize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: crypto.randomUUID(), consent }),
      });
      if (!response.ok) throw new Error(await readError(response, "图片识别失败"));
      const payload = await response.json() as { job: { status: string; failureCode?: string | null } };
      setMessage(payload.job.status === "succeeded"
        ? "识别完成。结果仍未进入记忆，请逐项检查并确认。"
        : payload.job.status === "unknown"
          ? "供应商返回状态未知，系统没有发布识别结果；请前往治理页人工收口。"
          : `识别任务状态：${payload.job.status}${payload.job.failureCode ? `（${payload.job.failureCode}）` : ""}`);
      setConsents((current) => ({ ...current, [asset.id]: false }));
      await reload();
    } catch (recognizeError) {
      setError(recognizeError instanceof Error ? recognizeError.message : "图片识别失败");
      await reload();
    } finally {
      setRecognizing(null);
    }
  }

  async function review(assetId: string, segment: Segment, action: "accept" | "dismiss") {
    setReviewing(segment.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${assetId}/segments/${segment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "accept" ? { action, reviewedText: edits[segment.id] ?? segment.contentText } : { action }),
      });
      if (!response.ok) throw new Error(await readError(response, "审核保存失败"));
      const payload = await response.json() as { asset: Asset };
      setAssets((current) => current.map((entry) => entry.id === assetId ? payload.asset : entry));
      setMessage(payload.asset.status === "ready" ? "该文件审核完成，已发布确认片段到项目资料库。" : "片段审核已保存。全部处理完后才会发布该文件。 ");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "审核保存失败");
    } finally {
      setReviewing(null);
    }
  }

  async function remove(asset: Asset) {
    const confirmation = await confirm({
      eyebrow: "Project files",
      title: `移除“${asset.displayName}”？`,
      description: "已生成的资料来源会停止参与后续 AI 处理；原文件与审计记录仍会保留，重新上传同一文件可以恢复。",
      confirmLabel: "确认移除",
      tone: "danger",
    });
    if (!confirmation.confirmed) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response, "文件移除失败"));
      setMessage("文件已从活动资料中移除；既有记忆索引会显示为待重建。重新上传同一文件可以恢复。 ");
      await reload();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "文件移除失败");
    }
  }

  async function retryParsing(asset: Asset) {
    setRetrying(asset.id);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}/retry`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "重新解析失败"));
      const payload = await response.json() as { asset: Asset };
      setMessage(payload.asset.status === "failed"
        ? "文件仍无法解析。请核对文件是否损坏、加密或超过格式安全限制。"
        : "文件已重新解析。若页面仍显示处理中，worker 会继续完成该持久任务。");
      await reload();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "重新解析失败");
      await reload();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="assets" />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <ProjectMaterialsParentLink projectId={projectId} />
        <section className="pb-8 pt-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Project files</p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
            <div><h1 className="text-4xl font-semibold tracking-[-0.04em]">{projectName} · 文件资料</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">上传文本、PDF、Word、PowerPoint、Excel 和图片。本地先完成结构化解析；图片与扫描 PDF 按项目配置调用视觉模型，人工确认后才进入项目记忆。</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-right shadow-sm"><p className="text-xs text-slate-400">当前页待人工确认</p><p className="mt-1 text-2xl font-semibold">{pendingCount}</p></div>
          </div>
        </section>

        {error ? <div role="alert" className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {message ? <div role="status" className="mb-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-800">{message}</div> : null}

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <div><h2 className="text-xl font-semibold">上传文件或文件夹</h2><p className="mt-2 text-xs leading-6 text-slate-500">单文件最大 {formatBytes(policy.maxFileBytes)}，图片最大 {formatBytes(policy.maxImageBytes)} / 2000 万像素；单次最多选择 {policy.maxFiles} 个，multipart 请求最大 {formatBytes(policy.maxRequestBytes)}。支持 TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP。</p><div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="flex min-h-28 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/60 px-6 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"><input type="file" multiple accept=".txt,.md,.json,.csv,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp" onChange={chooseFiles} className="sr-only" /><span>{files.length > 0 ? `已选择 ${files.length} 个文件` : "选择一个或多个文件"}</span></label><label className="flex min-h-28 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-violet-50/60 px-6 text-center text-sm font-semibold text-violet-700 hover:bg-violet-50"><input ref={(node) => { node?.setAttribute("webkitdirectory", ""); }} type="file" multiple onChange={chooseFiles} className="sr-only" /><span>选择整个本地文件夹</span></label></div>{files.length > 0 ? <p className="mt-3 line-clamp-2 text-xs text-slate-500">{files.map((file) => file.webkitRelativePath || file.name).join("、")}</p> : null}<p className="mt-4 text-xs leading-5 text-slate-500">服务端每次请求只接收一个文件，页面会按选择逐个提交；服务端还会按项目 {formatBytes(policy.maxProjectBytes)}、工作区 {formatBytes(policy.maxWorkspaceBytes)}、部署 {formatBytes(policy.maxDeploymentBytes)}、活动文件 {policy.maxProjectAssets} 以及保留对象 {policy.maxProjectRetainedObjects} / {policy.maxWorkspaceRetainedObjects} / {policy.maxDeploymentRetainedObjects} 限制；每用户每分钟最多 {policy.maxUploadsPerMinute} 次请求，同时最多 {policy.maxConcurrentUploads} 个，整套部署同时最多 {policy.maxGlobalConcurrentUploads} 个上传。</p></div>
            <button type="button" onClick={() => void upload()} disabled={uploading || files.length === 0} className="inline-flex h-12 min-w-36 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-40">{uploading ? "上传并解析中…" : "上传并解析"}</button>
          </div>
          <div className="mt-6 grid gap-3 border-t border-slate-100 pt-5 text-xs text-slate-500 sm:grid-cols-2 lg:grid-cols-3">
            <QuotaStat label="项目已用" value={`${formatBytes(Number(usage.projectBytes))} / ${formatBytes(policy.maxProjectBytes)}`} />
            <QuotaStat label="工作区上限（实际用量仅服务端校验）" value={formatBytes(policy.maxWorkspaceBytes)} />
            <QuotaStat label="部署上限（实际用量仅服务端校验）" value={formatBytes(policy.maxDeploymentBytes)} />
            <QuotaStat label="活动文件 / 进行中" value={`${usage.activeAssetCount} / ${policy.maxProjectAssets} · ${usage.activeUploads} / ${policy.maxConcurrentUploads}`} />
            <QuotaStat label="项目保留对象" value={`${usage.retainedObjectCount} / ${policy.maxProjectRetainedObjects}`} />
          </div>
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Asset library</p><h2 className="mt-2 text-2xl font-semibold">已上传文件</h2></div><button type="button" onClick={() => void reload()} className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600">刷新</button></div>
          <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[minmax(0,1fr)_180px_180px]"><label><span className="sr-only">搜索文件</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索文件名" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:bg-white" /></label><label><span className="sr-only">按文件类型筛选</span><select value={kindFilter} onChange={(event) => { setKindFilter(event.target.value); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700"><option value="all">全部文件类型</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className="sr-only">按处理状态筛选</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700"><option value="all">全部处理状态</option>{Object.entries(statusLabels).filter(([value]) => value !== "deleted").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          {loading ? <div className="mt-5 h-40 animate-pulse rounded-3xl bg-slate-200" /> : assets.length === 0 ? <div className="mt-5 rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">{search.trim() || kindFilter !== "all" || statusFilter !== "all" ? "没有匹配的文件，请调整关键词或筛选条件。" : "还没有文件。上传后，系统会显示解析、识别、审核与发布状态。"}</div> : <div className="mt-5 space-y-5">{assets.map((asset) => (
            <article key={asset.id} className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4 p-6 sm:p-7"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="max-w-xl truncate text-lg font-semibold">{asset.displayName}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{kindLabels[asset.kind]}</span><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusTone(asset.status)}`}>{statusLabels[asset.status]}</span></div><p className="mt-2 text-xs text-slate-400">{asset.version ? `${formatBytes(asset.version.sizeBytes)} · ${asset.version.mimeType}` : "版本信息不可用"} · {formatDate(asset.createdAt)}</p><p className="mt-3 text-xs leading-5 text-slate-500">已形成 {asset.segments.filter((segment) => segment.projectSourceId !== null).length} 个活动资料来源，共 {asset.segments.length} 个可定位片段。{asset.latestRun?.modelId ? ` 最近视觉模型：${asset.latestRun.modelId}。` : ""}</p>{asset.version?.failureCode || asset.latestRun?.failureCode ? <p className="mt-2 text-xs text-rose-600">失败代码：{asset.version?.failureCode ?? asset.latestRun?.failureCode}</p> : null}</div><div className="flex flex-wrap items-center gap-2">{asset.status === "failed" ? <button type="button" onClick={() => void retryParsing(asset)} disabled={retrying !== null} className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white disabled:opacity-40">{retrying === asset.id ? "重新解析中…" : "重新解析"}</button> : null}<a href={`/api/projects/${projectId}/assets/${asset.id}/download`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600">查看原文件</a><button type="button" onClick={() => void remove(asset)} className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-200 px-4 text-xs font-semibold text-rose-700">移除</button></div></div>

              {asset.status === "waitingVision" ? <div className="border-t border-amber-100 bg-amber-50/70 p-6 sm:px-7"><h4 className="text-sm font-semibold text-amber-950">需要视觉模型识别</h4><p className="mt-2 text-xs leading-5 text-amber-900">系统只发送该图片，或 PDF 中无足够本地文字的扫描页；不会发送项目中的其他资料。本次共有 {asset.segments.filter((segment) => segment.requiresVision).length} 个待识别片段。请先在 <Link href={`/projects/${projectId}/control`} className="font-semibold underline">智能控制台</Link> 配置“图片与扫描件识别”路由。</p><label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-white/70 px-4 py-3 text-xs leading-5 text-amber-950"><input type="checkbox" checked={consents[asset.id] ?? false} onChange={(event) => setConsents((current) => ({ ...current, [asset.id]: event.target.checked }))} className="mt-0.5" /><span>我确认将“{asset.displayName}”中上述 {asset.segments.filter((segment) => segment.requiresVision).length} 个图片或扫描页发送给项目当前配置的第三方视觉模型，并使用我的供应商额度。识别结果必须由我逐项确认后才会发布。</span></label><button type="button" onClick={() => void recognize(asset)} disabled={!consents[asset.id] || recognizing !== null} className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-amber-900 px-5 text-xs font-semibold text-white disabled:opacity-40">{recognizing === asset.id ? "识别中…" : "开始图片识别"}</button></div> : null}

              {asset.status === "awaitingReview" ? <div className="border-t border-indigo-100 bg-indigo-50/40 p-6 sm:px-7"><div className="mb-4"><h4 className="text-sm font-semibold text-indigo-950">确认识别结果</h4><p className="mt-2 text-xs leading-5 text-indigo-800">所有片段审核结束后，接受的内容才会一起发布到项目资料库；驳回的片段不会参与记忆与问答。</p></div><div className="space-y-4">{asset.segments.map((segment) => <div key={segment.id} className="rounded-2xl border border-indigo-100 bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-700">{segment.locatorLabel}</p><span className="text-[11px] text-slate-400">{segment.extractionMethod === "vision" ? `${segment.providerConnection?.name ?? "视觉模型"} · ${segment.modelId ?? "模型未记录"}` : "本地解析"}</span></div>{segment.reviewStatus === "pending" ? <><textarea value={edits[segment.id] ?? segment.contentText} onChange={(event) => setEdits((current) => ({ ...current, [segment.id]: event.target.value }))} rows={Math.min(12, Math.max(5, Math.ceil((edits[segment.id] ?? segment.contentText).length / 100)))} className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-700 outline-none focus:border-indigo-400" /><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void review(asset.id, segment, "accept")} disabled={reviewing !== null || !(edits[segment.id] ?? segment.contentText).trim()} className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-600 px-4 text-xs font-semibold text-white disabled:opacity-40">{reviewing === segment.id ? "保存中…" : "确认并保留"}</button><button type="button" onClick={() => void review(asset.id, segment, "dismiss")} disabled={reviewing !== null} className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600 disabled:opacity-40">驳回片段</button></div></> : <p className="mt-3 text-xs text-slate-500">{segment.reviewStatus === "accepted" ? "已确认，等待文件其余片段完成。" : "已驳回，不会发布。"}</p>}</div>)}</div></div> : null}
            </article>
          ))}</div>}
          <ListPagination {...pagination} onPageChange={setPage} disabled={loading} />
        </section>
        {dialog}
      </div>
    </main>
  );
}

function QuotaStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-slate-50 px-3 py-3"><p className="font-semibold text-slate-700">{value}</p><p className="mt-1 text-[11px] text-slate-400">{label}</p></div>;
}
