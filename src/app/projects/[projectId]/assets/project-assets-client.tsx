"use client";

import { DialogActions } from "@/components/dialog-actions";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { OperationPanel } from "@/components/operation-panel";
import { awaitImportedAsset } from "../imported-asset-readiness";
import { ProjectFactImport } from "../project-fact-import";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ListPagination } from "@/components/list-pagination";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { initializeReviewDrafts } from "@/lib/project-asset-review-drafts";
import { DEFAULT_UPLOAD_POLICY, type PublicUploadPolicy } from "@/lib/project-assets/policy";
import { buildProjectHref, parseProjectPageState, PROJECT_UUID_PATTERN } from "@/lib/project-navigation";
import supportStyles from "../project-support.module.css";
import { formatUiDateTime } from "@/lib/ui-date-format";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { projectAssetUploadRequest } from "@/lib/project-assets/upload-request";
import { selectSupportedProjectAssetFiles } from "@/lib/project-assets/file-selection";

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
type Confirmation = {
  challengeId: string;
  targetAction: string;
  expiresAt: string;
  safeSummary: Record<string, unknown>;
};
type ApiFailure = { code?: string; message?: string };

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

async function readApiFailure(response: Response, fallback: string): Promise<ApiFailure> {
  const failure = await safeResponseError(response, fallback);
  return { code: failure.code ?? undefined, message: failure.message };
}

function confirmationMessage(code: string | undefined): string | null {
  if (code === "WEB_AI_CONFIRMATION_EXPIRED") return "本次确认已过期，请重新读取外发摘要。";
  if (code === "WEB_AI_CONFIRMATION_STALE") return "文件内容或模型路由已变化，请重新读取外发摘要。";
  if (code === "WEB_AI_CONFIRMATION_CONSUMED") return "本次确认已使用，请重新读取外发摘要后再执行。";
  if (code === "WEB_AI_CONFIRMATION_REQUIRED") return "请先读取本次外发摘要，再点击确认并执行。";
  return null;
}

function summaryText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(summaryText).join("、");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${summaryText(entry)}`).join(" · ");
  return "—";
}

function beginAssetFlight(ref: { current: Record<string, symbol | undefined> }, assetId: string): symbol | null {
  if (ref.current[assetId] !== undefined) return null;
  const token = Symbol("web-ai-flight");
  ref.current[assetId] = token;
  return token;
}

function endAssetFlight(ref: { current: Record<string, symbol | undefined> }, assetId: string, token: symbol): void {
  if (ref.current[assetId] === token) delete ref.current[assetId];
}

function ConfirmationCard({ confirmation, pending, executeLabel, onExecute }: { confirmation: Confirmation; pending: boolean; executeLabel: string; onExecute: () => void }) {
  const { language } = useAppearance();
  return <div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4" role="status">
    <p className="text-sm font-semibold text-indigo-900"><UiText text={"本次外发摘要"} /></p>
    <p className="mt-2 text-xs leading-5 text-indigo-800"><UiText text={"动作："} />{confirmation.targetAction} {" "}<UiText text={"· 路由："} />{summaryText(confirmation.safeSummary.route)} {" "}<UiText text={"· 范围："} />{summaryText(confirmation.safeSummary.scope)}</p>
    <p className="mt-2 text-xs text-indigo-700"><UiText text={"确认有效期至"} />{" "}{formatDate(confirmation.expiresAt, language)}<UiText text={"。摘要不包含原文、问题或指纹。"} /></p>
    <DialogActions><button type="button" onClick={onExecute} disabled={pending} className="mt-4 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? <UiText text={"执行中…"} /> : executeLabel}</button></DialogActions>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string, language: "zh-CN" | "en"): string {
  return formatUiDateTime(new Date(value), language, { dateStyle: "medium", timeStyle: "short" });
}

function statusTone(status: AssetStatus): string {
  if (status === "ready") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "failed") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (status === "waitingVision" || status === "awaitingReview") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

export function ProjectAssetsClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("assets", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const focusedAssetId = navigation.focus !== null && PROJECT_UUID_PATTERN.test(navigation.focus) ? navigation.focus : null;
  const [projectName, setProjectName] = useState("项目");
  const [assets, setAssets] = useState<Asset[]>([]);
  const displayedAssets = useMemo(() => focusedAssetId === null ? assets : assets.filter((asset) => asset.id === focusedAssetId), [assets, focusedAssetId]);
  const [pagination, setPagination] = useState<ListPaginationState>({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [factSourceIds, setFactSourceIds] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Array<{ name: string; message: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [recognizing, setRecognizing] = useState<Record<string, boolean>>({});
  const [processingJobIds, setProcessingJobIds] = useState<Record<string, string | undefined>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, Confirmation | undefined>>({});
  const [clientKeys, setClientKeys] = useState<Record<string, string | undefined>>({});
  const reloadSequenceRef = useRef(0);
  const reloadControllerRef = useRef<AbortController | null>(null);
  const prepareSequences = useRef<Record<string, number>>({});
  const prepareControllers = useRef<Record<string, AbortController | undefined>>({});
  const flightRef = useRef<Record<string, symbol | undefined>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PublicUploadPolicy>(DEFAULT_UPLOAD_POLICY);
  const [usage, setUsage] = useState<UploadUsage>({ projectBytes: "0", activeAssetCount: 0, retainedObjectCount: 0, activeUploads: 0 });
  const { confirm, dialog } = useAppConfirmDialog();

  function invalidatePrepareRequest(assetId: string) {
    prepareSequences.current[assetId] = (prepareSequences.current[assetId] ?? 0) + 1;
    prepareControllers.current[assetId]?.abort();
    prepareControllers.current[assetId] = undefined;
  }

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    const sequence = ++reloadSequenceRef.current;
    reloadControllerRef.current?.abort();
    const controller = new AbortController();
    reloadControllerRef.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && reloadSequenceRef.current === sequence;
    if (showLoading) setLoading(true);
    try {
      const listParams = new URLSearchParams({
        page: String(focusedAssetId === null ? page : 1),
        pageSize: "10",
        ...(focusedAssetId === null && deferredSearch.trim() ? { search: deferredSearch.trim() } : {}),
        kind: focusedAssetId === null ? kindFilter : "all",
        status: focusedAssetId === null ? statusFilter : "all",
      });
      const [projectResponse, assetsResponse, focusedAssetResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store", signal: controller.signal }),
        fetch(`/api/projects/${projectId}/assets?${listParams}`, { cache: "no-store", signal: controller.signal }),
        focusedAssetId === null ? Promise.resolve(null) : fetch(`/api/projects/${projectId}/assets/${focusedAssetId}`, { cache: "no-store", signal: controller.signal }),
      ]);
      if (!isCurrentRequest()) return;
      if (!projectResponse.ok || !assetsResponse.ok) {
        const failed = !projectResponse.ok ? projectResponse : assetsResponse;
        throw new Error(await readError(failed, "文件资料加载失败"));
      }
      if (focusedAssetResponse !== null && !focusedAssetResponse.ok) {
        throw new Error(await readError(focusedAssetResponse, "指定文件加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const assetsPayload = await assetsResponse.json() as { assets: Asset[]; pagination: ListPaginationState; policy?: PublicUploadPolicy; usage?: UploadUsage };
      const focusedPayload = focusedAssetResponse === null ? null : await focusedAssetResponse.json() as { asset: Asset };
      if (!isCurrentRequest()) return;
      const refreshedAssets = focusedPayload === null ? assetsPayload.assets : [focusedPayload.asset];
      setProjectName(projectPayload.project.name);
      setAssets(refreshedAssets);
      setPagination(focusedPayload === null ? assetsPayload.pagination : { page: 1, pageSize: 1, total: 1, totalPages: 1 });
      if (focusedPayload === null && page > assetsPayload.pagination.totalPages) setPage(assetsPayload.pagination.totalPages);
      if (assetsPayload.policy) setPolicy(assetsPayload.policy);
      if (assetsPayload.usage) setUsage(assetsPayload.usage);
      setEdits((current) => {
        return initializeReviewDrafts(current, refreshedAssets);
      });
      setError(null);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      if (focusedAssetId !== null) {
        setAssets([]);
        setPagination({ page: 1, pageSize: 1, total: 0, totalPages: 1 });
      }
      setError(loadError instanceof Error ? loadError.message : "文件资料加载失败");
    } finally {
      if (isCurrentRequest()) {
        if (reloadControllerRef.current === controller) reloadControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [deferredSearch, focusedAssetId, kindFilter, page, projectId, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      reloadSequenceRef.current += 1;
      reloadControllerRef.current?.abort();
      reloadControllerRef.current = null;
    };
  }, [reload]);

  const pendingCount = useMemo(() => displayedAssets.reduce((count, asset) =>
    count + asset.segments.filter((segment) => segment.reviewStatus === "pending" && !segment.requiresVision).length, 0), [displayedAssets]);

  function showAllAssets() {
    setLoading(true);
    reloadSequenceRef.current += 1;
    reloadControllerRef.current?.abort();
    reloadControllerRef.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("focus");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    setUploadErrors([]);
    const selected = Array.from(event.target.files ?? []);
    const { accepted, unsupported, excess } = selectSupportedProjectAssetFiles(selected, policy.maxFiles);
    setFiles(accepted);
    const notices: string[] = [];
    if (unsupported.length > 0) {
      const names = unsupported.slice(0, 3).map((file) => file.name).join("、");
      notices.push(`已跳过 ${unsupported.length} 个不支持的文件：${names}${unsupported.length > 3 ? "等" : ""}。`);
    }
    if (excess.length > 0) notices.push(`单次最多选择 ${policy.maxFiles} 个受支持文件，已保留前 ${policy.maxFiles} 个。`);
    setMessage(notices.length > 0 ? notices.join(" ") : accepted.length > 0 ? `已选择 ${accepted.length} 个受支持文件。` : null);
  }

  async function upload() {
    if (files.length === 0) return;
    setFactSourceIds([]);
    setUploading(true);
    setError(null);
    setUploadErrors([]);
    const readySourceIds: string[] = [];
    const pendingParsing: string[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    const parseFailures: string[] = [];
    for (const file of files) {
      try {
        const response = await fetch(`/api/projects/${projectId}/assets`, projectAssetUploadRequest(file));
        if (!response.ok) throw new Error(await readError(response, "上传失败"));
        const payload = await response.json() as { asset?: Asset };
        const readiness = payload.asset ? await awaitImportedAsset(projectId, payload.asset, () => setMessage("正在等待文件的本地解析…")) : null;
        if (readiness?.pending) pendingParsing.push(file.name);
        readySourceIds.push(...(readiness?.asset.segments ?? []).flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []));
        if (readiness?.asset.status === "failed") parseFailures.push(file.name);
      } catch (uploadError) {
        failures.push({ name: file.name, message: uploadError instanceof Error ? uploadError.message : "上传失败" });
      }
    }
    setFiles([]);
    setUploadErrors(failures);
    setFactSourceIds([...new Set(readySourceIds)]);
    setMessage(failures.length === 0
      ? parseFailures.length === 0
        ? pendingParsing.length > 0 ? "文件已保存，部分文件仍在后台解析，请稍后刷新文件状态。" : "文件已保存，请查看每个文件的处理状态。"
        : "文件已保存，部分文件本地解析失败，请在文件卡片中查看详情。"
      : "部分文件上传失败，请查看每个文件的具体原因。");
    await reload();
    setUploading(false);
  }

  async function prepareRecognition(asset: Asset) {
    const preparedClientKey = crypto.randomUUID();
    const flightToken = beginAssetFlight(flightRef, asset.id);
    if (flightToken === null) return;
    invalidatePrepareRequest(asset.id);
    const sequence = prepareSequences.current[asset.id]!;
    const controller = new AbortController();
    prepareControllers.current[asset.id] = controller;
    setRecognizing((current) => ({ ...current, [asset.id]: true }));
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}/recognize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "prepare", clientKey: preparedClientKey }),
        signal: controller.signal,
      });
      if (sequence !== prepareSequences.current[asset.id] || controller.signal.aborted) return;
      if (!response.ok) {
        const failure = await readApiFailure(response, "外发摘要读取失败");
        throw new Error(failure.message ?? "外发摘要读取失败");
      }
      const payload = await response.json() as { confirmation: Confirmation };
      setConfirmations((current) => ({ ...current, [asset.id]: payload.confirmation }));
      setClientKeys((current) => ({ ...current, [asset.id]: preparedClientKey }));
      setMessage("已读取本次外发摘要。请核对文件范围和路由后，点击确认并执行。");
    } catch (prepareError) {
      if (controller.signal.aborted || sequence !== prepareSequences.current[asset.id]) return;
      setError(prepareError instanceof Error ? prepareError.message : "外发摘要读取失败");
    } finally {
      if (sequence === prepareSequences.current[asset.id]) {
        setRecognizing((current) => {
          const next = { ...current };
          delete next[asset.id];
          return next;
        });
        if (prepareControllers.current[asset.id] === controller) prepareControllers.current[asset.id] = undefined;
      }
      endAssetFlight(flightRef, asset.id, flightToken);
    }
  }

  async function recognize(asset: Asset) {
    const confirmation = confirmations[asset.id];
    const clientKey = clientKeys[asset.id];
    if (confirmation === undefined || clientKey === undefined) {
      setMessage("请先读取本次外发摘要。");
      return;
    }
    const flightToken = beginAssetFlight(flightRef, asset.id);
    if (flightToken === null) return;
    setRecognizing((current) => ({ ...current, [asset.id]: true }));
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assets/${asset.id}/recognize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey }),
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, "图片识别失败");
        const nextStep = confirmationMessage(failure.code);
        if (nextStep !== null) {
          setConfirmations((current) => ({ ...current, [asset.id]: undefined }));
          setClientKeys((current) => ({ ...current, [asset.id]: undefined }));
        }
        throw new Error(nextStep ?? failure.message ?? "图片识别失败");
      }
      const payload = await response.json() as { job: { id: string; status: string; failureCode?: string | null } };
      setProcessingJobIds((current) => ({ ...current, [asset.id]: payload.job.id }));
      setMessage(payload.job.status === "queued"
        ? "识别已加入后台任务，可继续操作其他文件；识别结果不会自动发布。"
        : payload.job.status === "succeeded"
        ? "识别完成。结果仍未进入记忆，请逐项检查并确认。"
        : payload.job.status === "unknown"
          ? "供应商返回状态未知，系统没有发布识别结果；请前往治理页人工收口。"
          : `识别任务状态：${payload.job.status}${payload.job.failureCode ? `（${payload.job.failureCode}）` : ""}`);
      setConfirmations((current) => ({ ...current, [asset.id]: undefined }));
      setClientKeys((current) => ({ ...current, [asset.id]: undefined }));
      await reload();
    } catch (recognizeError) {
      setError(recognizeError instanceof Error ? recognizeError.message : "图片识别失败");
      await reload();
    } finally {
      setRecognizing((current) => {
        const next = { ...current };
        delete next[asset.id];
        return next;
      });
      endAssetFlight(flightRef, asset.id, flightToken);
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
    <main className={supportStyles.supportPage}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="assets" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <ProjectMaterialsParentLink projectId={projectId} />
        <section className="pb-8 pt-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600"><UiText text={"Project files"} /></p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
            <div><h1 className="text-4xl font-semibold tracking-[-0.04em]">{projectName} {" "}<UiText text={"· 文件资料"} /></h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600"><UiText text={"上传文本、PDF、Word、PowerPoint、Excel 和图片。本地先完成结构化解析；原图、扫描 PDF 页和 Office 内嵌图片经确认后调用视觉模型，识别文字核对后可交给 AI 整理；有原文证据的内容自动形成事实，仅冲突与不确定项待处理。"} /></p></div>
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-right shadow-sm"><p className="text-xs text-slate-400"><UiText text={"当前页待人工确认"} /></p><p className="mt-1 text-2xl font-semibold">{pendingCount}</p></div>
          </div>
        </section>

        {error ? <div role="alert" className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><UiErrorText text={error} /></div> : null}
        {message ? <div role="status" className="mb-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-800"><UiFeedbackText text={message} /></div> : null}

        <OperationPanel title={translateUi("导入文件并整理事实")} triggerLabel="导入文件或文件夹">
          {error ? <p role="alert" className="mb-4 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
          {uploadErrors.length > 0 ? <ul className="mb-4 space-y-3 text-sm text-rose-700">{uploadErrors.map((failure, index) => <li key={`${index}:${failure.name}`} className="break-words border-b border-slate-200 pb-3"><p className="font-semibold">{failure.name}</p><p><UiErrorText text={failure.message} /></p></li>)}</ul> : null}
          {message ? <p role="status" className="mb-4 text-sm text-indigo-700"><UiFeedbackText text={message} /></p> : null}
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <div><p className="text-xs leading-6 text-slate-500"><UiText text={"单文件大小："} />{policy.maxFileBytes > 0 ? formatBytes(policy.maxFileBytes) : <UiText text={"不限"} />}<UiText text={"；图片大小："} />{policy.maxImageBytes > 0 ? formatBytes(policy.maxImageBytes) : <UiText text={"不限"} />}<UiText text={"。图片像素和文档解析仍有处理上限；单次最多选择"} />{" "}{policy.maxFiles}<UiText text={"个文件。支持 TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP。"} /></p><div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="flex min-h-28 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/60 px-6 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"><input type="file" multiple onChange={chooseFiles} className="sr-only" /><span>{files.length > 0 ? `已选择 ${files.length} 个文件` : <UiText text={"选择一个或多个文件"} />}</span></label><label className="flex min-h-28 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-violet-50/60 px-6 text-center text-sm font-semibold text-violet-700 hover:bg-violet-50"><input ref={(node) => { node?.setAttribute("webkitdirectory", ""); }} type="file" multiple onChange={chooseFiles} className="sr-only" /><span><UiText text={"选择整个本地文件夹"} /></span></label></div>{files.length > 0 ? <p className="mt-3 line-clamp-2 text-xs text-slate-500">{files.map((file) => file.webkitRelativePath || file.name).join("、")}</p> : null}<p className="mt-4 text-xs leading-5 text-slate-500"><UiText text={"文件逐个流式上传；容量预算仍按项目"} />{" "}{formatBytes(policy.maxProjectBytes)}<UiText text={"、工作区"} />{" "}{formatBytes(policy.maxWorkspaceBytes)}<UiText text={"、部署"} />{" "}{formatBytes(policy.maxDeploymentBytes)}<UiText text={"、活动文件"} />{" "}{policy.maxProjectAssets} {" "}<UiText text={"以及保留对象"} />{" "}{policy.maxProjectRetainedObjects} / {policy.maxWorkspaceRetainedObjects} / {policy.maxDeploymentRetainedObjects} {" "}<UiText text={"限制；每用户每分钟最多"} />{" "}{policy.maxUploadsPerMinute} {" "}<UiText text={"次请求，同时最多"} />{" "}{policy.maxConcurrentUploads} {" "}<UiText text={"个，整套部署同时最多"} />{" "}{policy.maxGlobalConcurrentUploads} {" "}<UiText text={"个上传。"} /></p></div>
            <DialogActions><button type="button" onClick={() => void upload()} disabled={uploading || files.length === 0} className="app-action-button app-action-button--compact justify-self-end rounded-xl bg-indigo-600 font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">{uploading ? <UiText text={"上传并解析中…"} /> : <UiText text={"上传并解析"} />}</button></DialogActions>
          </div>
          <div className="mt-6 grid gap-3 border-t border-slate-100 pt-5 text-xs text-slate-500 sm:grid-cols-2 lg:grid-cols-3">
            <QuotaStat label={translateUi("项目已用")} value={`${formatBytes(Number(usage.projectBytes))} / ${formatBytes(policy.maxProjectBytes)}`} />
            <QuotaStat label={translateUi("工作区上限（实际用量仅服务端校验）")} value={formatBytes(policy.maxWorkspaceBytes)} />
            <QuotaStat label={translateUi("部署上限（实际用量仅服务端校验）")} value={formatBytes(policy.maxDeploymentBytes)} />
            <QuotaStat label={translateUi("活动文件 / 进行中")} value={`${usage.activeAssetCount} / ${policy.maxProjectAssets} · ${usage.activeUploads} / ${policy.maxConcurrentUploads}`} />
            <QuotaStat label={translateUi("项目保留对象")} value={`${usage.retainedObjectCount} / ${policy.maxProjectRetainedObjects}`} />
          </div>
          <div className={factSourceIds.length > 0 ? "mt-5" : undefined}><ProjectFactImport key={factSourceIds.join(",")} projectId={projectId} sourceIds={factSourceIds} onChanged={reload} /></div>
        </OperationPanel>

        <section className="mt-8">
          <div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><UiText text={"Asset library"} /></p><h2 className="mt-2 text-2xl font-semibold"><UiText text={"已上传文件"} /></h2></div><button type="button" onClick={() => void reload({ showLoading: true })} disabled={loading} className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 disabled:opacity-50"><UiText text={"刷新文件状态"} /></button></div>
          {focusedAssetId !== null ? <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900"><p><UiText text={"当前仅显示指定文件。"} /></p><button type="button" onClick={showAllAssets} className="font-semibold underline underline-offset-4"><UiText text={"查看全部文件"} /></button></div> : <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[minmax(0,1fr)_180px_180px]"><label><span className="sr-only"><UiText text={"搜索文件"} /></span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={translateUi("搜索文件名")} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:bg-white" /></label><label><span className="sr-only"><UiText text={"按文件类型筛选"} /></span><select value={kindFilter} onChange={(event) => { setKindFilter(event.target.value); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700"><option value="all"><UiText text={"全部文件类型"} /></option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label><label><span className="sr-only"><UiText text={"按处理状态筛选"} /></span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700"><option value="all"><UiText text={"全部处理状态"} /></option>{Object.entries(statusLabels).filter(([value]) => value !== "deleted").map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label></div>}
          {loading || (focusedAssetId !== null && displayedAssets.length === 0 && error === null) ? <div className="mt-5 h-40 animate-pulse rounded-3xl bg-slate-200" /> : displayedAssets.length === 0 ? <div className="mt-5 rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">{focusedAssetId !== null ? <UiText text={"未找到指定文件。"} /> : search.trim() || kindFilter !== "all" || statusFilter !== "all" ? <UiText text={"没有匹配的文件，请调整关键词或筛选条件。"} /> : <UiText text={"还没有文件。上传后，系统会显示解析、识别、审核与发布状态。"} />}</div> : <div className="mt-5 space-y-5">{displayedAssets.map((asset) => (
            <article key={asset.id} className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4 p-6 sm:p-7"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="max-w-xl truncate text-lg font-semibold">{asset.displayName}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{translateUi(kindLabels[asset.kind])}</span><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${statusTone(asset.status)}`}>{translateUi(statusLabels[asset.status])}</span></div><p className="mt-2 text-xs text-slate-400">{asset.version ? `${formatBytes(asset.version.sizeBytes)} · ${asset.version.mimeType}` : <UiText text={"版本信息不可用"} />} · {formatDate(asset.createdAt, language)}</p><p className="mt-3 text-xs leading-5 text-slate-500"><UiText text={"已形成"} />{" "}{asset.segments.filter((segment) => segment.projectSourceId !== null).length} {" "}<UiText text={"个活动资料来源，共"} />{" "}{asset.segments.length} {" "}<UiText text={"个可定位片段。"} />{asset.latestRun?.modelId ? <> <UiText text={"最近视觉模型："} />{asset.latestRun.modelId}<UiText text={"。"} /></> : ""}</p>{asset.version?.failureCode === "ASSET_FILE_PROCESSING_TOO_LARGE" ? <p className="mt-2 text-xs text-amber-700"><UiText text={"原文件已保存，但超过本地解析处理能力。请拆分文件后重新上传整理；原文件仍可下载。"} /></p> : null}{asset.version?.failureCode || asset.latestRun?.failureCode ? <p className="mt-2 text-xs text-rose-600"><UiText text={"失败代码："} />{asset.version?.failureCode ?? asset.latestRun?.failureCode}</p> : null}</div><div className="flex flex-wrap items-center gap-2">{asset.status === "failed" ? <button type="button" onClick={() => void retryParsing(asset)} disabled={retrying !== null} className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-xs font-semibold text-white disabled:opacity-40">{retrying === asset.id ? <UiText text={"重新解析中…"} /> : <UiText text={"重新解析"} />}</button> : null}<a href={`/api/projects/${projectId}/assets/${asset.id}/download`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600"><UiText text={"查看原文件"} /></a><button type="button" onClick={() => void remove(asset)} className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-200 px-4 text-xs font-semibold text-rose-700"><UiText text={"移除"} /></button></div></div>

              {asset.status === "waitingVision" ? <OperationPanel className="px-6 pb-5" title={translateUi("识别文件中的图片")} triggerLabel="开始图片识别">{error ? <p role="alert" className="mb-4 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}{message ? <p role="status" className="mb-4 text-sm text-slate-700"><UiFeedbackText text={message} /></p> : null}{processingJobIds[asset.id] ? <Link href={buildProjectHref(projectId, "materials", { view: "tasks", from: "materials" })} className="mb-4 inline-block text-sm font-semibold text-indigo-700 underline"><UiText text={"查看任务进度和取消 →"} /></Link> : null}<div className="border-t border-amber-100 bg-amber-50/70 p-6 sm:px-7"><h4 className="text-sm font-semibold text-amber-950"><UiText text={"需要视觉模型识别"} /></h4><p className="mt-2 text-xs leading-5 text-amber-900"><UiText text={"本次只发送此文件中标为待识别的原图、扫描 PDF 页或 Office 内嵌图片；不会发送项目中的其他资料。共"} />{" "}{asset.segments.filter((segment) => segment.requiresVision).length} {" "}<UiText text={"个片段。请先在"} />{" "}<Link href={`/projects/${projectId}/control`} className="font-semibold underline"><UiText text={"智能控制台"} /></Link> {" "}<UiText text={"配置“图片与扫描件识别”路由。"} /></p><ul className="mt-3 list-inside list-disc space-y-1 text-xs text-amber-950">{asset.segments.filter((segment) => segment.requiresVision).map((segment) => <li key={segment.id}>{segment.locatorLabel}</li>)}</ul>{confirmations[asset.id] ? <ConfirmationCard confirmation={confirmations[asset.id]!} pending={recognizing[asset.id] === true} executeLabel="加入后台识别任务" onExecute={() => void recognize(asset)} /> : <DialogActions><button type="button" onClick={() => void prepareRecognition(asset)} disabled={recognizing[asset.id] === true} className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-amber-900 px-5 text-xs font-semibold text-white disabled:opacity-40">{recognizing[asset.id] ? <UiText text={"读取摘要中…"} /> : <UiText text={"读取本次外发摘要"} />}</button></DialogActions>}</div></OperationPanel> : null}

              {asset.status === "awaitingReview" ? <OperationPanel className="px-6 pb-5" title={translateUi("核对识别文字")} triggerLabel="核对识别结果">{error ? <p role="alert" className="mb-4 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}{message ? <p role="status" className="mb-4 text-sm text-slate-700"><UiFeedbackText text={message} /></p> : null}<div className="border-t border-slate-200 pt-4 text-slate-700"><div className="mb-4"><h4 className="text-sm font-semibold text-slate-900"><UiText text={"确认识别结果"} /></h4><p className="mt-2 text-xs leading-5 text-slate-600"><UiText text={"所有片段审核结束后，接受的内容才会一起发布到项目资料库；驳回的片段不会参与记忆与问答。"} /></p></div><div className="space-y-4">{asset.segments.map((segment) => <div key={segment.id} className="border-t border-slate-200 pt-4 first:border-t-0 first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-700">{segment.locatorLabel}</p><span className="text-[12px] text-slate-400">{segment.extractionMethod === "vision" ? `${segment.providerConnection?.name ?? "视觉模型"} · ${segment.modelId ?? "模型未记录"}` : <UiText text={"本地解析"} />}</span></div>{segment.reviewStatus === "pending" ? <><textarea value={edits[segment.id] ?? segment.contentText} onChange={(event) => setEdits((current) => ({ ...current, [segment.id]: event.target.value }))} rows={Math.min(12, Math.max(5, Math.ceil((edits[segment.id] ?? segment.contentText).length / 100)))} className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-700 outline-none focus:border-indigo-400" /><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void review(asset.id, segment, "accept")} disabled={reviewing !== null || !(edits[segment.id] ?? segment.contentText).trim()} className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-600 px-4 text-xs font-semibold text-white disabled:opacity-40">{reviewing === segment.id ? <UiText text={"保存中…"} /> : <UiText text={"确认并保留"} />}</button><button type="button" onClick={() => void review(asset.id, segment, "dismiss")} disabled={reviewing !== null} className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600 disabled:opacity-40"><UiText text={"驳回片段"} /></button></div></> : <p className="mt-3 text-xs text-slate-500">{segment.reviewStatus === "accepted" ? <UiText text={"已确认，等待文件其余片段完成。"} /> : <UiText text={"已驳回，不会发布。"} />}</p>}</div>)}</div></div></OperationPanel> : null}
              {asset.status === "ready" ? <OperationPanel className="px-6 pb-5" title={translateUi("整理文件中的事实")} triggerLabel="AI 整理事实"><ProjectFactImport projectId={projectId} sourceIds={asset.segments.flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : [])} onChanged={reload} /></OperationPanel> : null}
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
  return <div className="rounded-xl bg-slate-50 px-3 py-3"><p className="font-semibold text-slate-700">{value}</p><p className="mt-1 text-[12px] text-slate-400">{label}</p></div>;
}
