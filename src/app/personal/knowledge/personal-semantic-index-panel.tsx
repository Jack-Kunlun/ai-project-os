"use client";

import { useEffect, useRef, useState } from "react";
import { safeResponseError } from "@/lib/safe-error-presentation";

type SemanticProvider = Readonly<{
  id: string;
  name: string;
  status: string;
  disabledAt: string | null;
  defaultEmbeddingModelId: string | null;
  embeddingDimensions: number | null;
}>;

type SemanticSummaryDocument = Readonly<{
  documentId: string;
  title: string;
  version: number;
  revisionId: string;
  chunkCount: number;
  sourceBytes: number;
}>;

type SemanticConfirmationSummary = Readonly<{
  action: "personalKnowledgeSemanticBuild";
  corpusEpoch: number;
  documents: readonly SemanticSummaryDocument[];
  totalChunks: number;
  totalSourceBytes: number;
  provider: Readonly<{ name: string; model: string; dimensions: number }>;
  expiresAt: string;
}>;

type SemanticConfirmation = Readonly<{
  challengeId: string;
  kind: "build";
  issuedAt: string;
  expiresAt: string;
  safeSummary: SemanticConfirmationSummary;
}>;

type SemanticIndexOverview = Readonly<{
  status: "not_available" | "building" | "ready" | "stale" | "failed";
  label: string;
  generationId?: string;
  indexedEntryCount?: number;
  dimensions?: number;
  modelId?: string;
  completedAt?: string | null;
}>;

type SemanticIndexState = "idle" | "preparing" | "awaiting-confirmation" | "executing" | "success" | "error";

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

async function responseError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1_024) return `${Math.max(0, bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatDate(value: string | null | undefined): string {
  if (value === undefined || value === null) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date)
    : "—";
}

function formatExpiry(value: string): string {
  return formatDate(value);
}

function randomClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `personal-semantic-build-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build the owner scoped personal semantic index. Index creation is explicit,
 * bounded, and two phase so the outbound document set is reviewable first.
 */
export function PersonalSemanticIndexPanel({
  onError,
}: Readonly<{ onError?: (message: string) => void }>): React.JSX.Element {
  const [state, setState] = useState<SemanticIndexState>("idle");
  const [confirmation, setConfirmation] = useState<SemanticConfirmation | null>(null);
  const [overview, setOverview] = useState<SemanticIndexOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly SemanticProvider[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexedEntryCount, setIndexedEntryCount] = useState<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const clientKeyRef = useRef(randomClientKey());

  useEffect(() => {
    const controller = new AbortController();
    async function loadOverview(): Promise<void> {
      try {
        const response = await fetch("/api/personal/knowledge/semantic-index", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response, "语义索引状态暂时不可用"));
        const payload = await response.json() as SemanticIndexOverview;
        setOverview(payload);
        setIndexedEntryCount(typeof payload.indexedEntryCount === "number" ? payload.indexedEntryCount : null);
        setOverviewError(null);
      } catch (cause) {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setOverviewError(cause instanceof Error ? cause.message : "语义索引状态暂时不可用");
      } finally {
        if (!controller.signal.aborted) setOverviewLoading(false);
      }
    }
    void loadOverview();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadProviders(): Promise<void> {
      try {
        const response = await fetch("/api/me/ai-providers", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response, "个人向量模型列表暂时不可用"));
        const payload = await response.json() as { providers?: readonly SemanticProvider[] };
        const available = (payload.providers ?? []).filter((provider) => (
          provider.status === "verified"
          && provider.disabledAt === null
          && provider.defaultEmbeddingModelId !== null
          && Number.isSafeInteger(provider.embeddingDimensions)
        ));
        setProviders(available);
        setProviderId((current) => current !== null && available.some((provider) => provider.id === current)
          ? current
          : (available[0]?.id ?? null));
        setProvidersError(null);
      } catch (cause) {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setProvidersError(cause instanceof Error ? cause.message : "个人向量模型列表暂时不可用");
      } finally {
        if (!controller.signal.aborted) setProvidersLoading(false);
      }
    }
    void loadProviders();
    return () => controller.abort();
  }, []);

  function cancelConfirmation(): void {
    setConfirmation(null);
    setError(null);
    setState("idle");
  }

  async function prepare(): Promise<void> {
    if (providerId === null) {
      setError("请选择一个已验证且支持向量的个人模型后再建立索引。");
      setState("error");
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    clientKeyRef.current = randomClientKey();
    setState("preparing");
    setError(null);
    setConfirmation(null);
    try {
      const response = await fetch("/api/personal/knowledge/semantic-index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ phase: "prepare", providerId, clientKey: clientKeyRef.current }),
      });
      if (!response.ok) throw new Error(await responseError(response, "当前还不能准备语义索引"));
      const payload = await response.json() as { challengeId?: string; kind?: "build"; issuedAt?: string; expiresAt?: string; safeSummary?: SemanticConfirmationSummary };
      if (payload.challengeId === undefined || payload.kind !== "build" || payload.issuedAt === undefined || payload.expiresAt === undefined || payload.safeSummary === undefined) {
        throw new Error("服务端没有返回完整的语义索引确认摘要");
      }
      setConfirmation({
        challengeId: payload.challengeId,
        kind: payload.kind,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        safeSummary: payload.safeSummary,
      });
      setState("awaiting-confirmation");
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const message = cause instanceof Error ? cause.message : "当前还不能准备语义索引";
      setError(message);
      onError?.(message);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  async function execute(): Promise<void> {
    if (confirmation === null || state === "executing") return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState("executing");
    setError(null);
    try {
      const response = await fetch("/api/personal/knowledge/semantic-index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey: clientKeyRef.current }),
      });
      if (!response.ok) throw new Error(await responseError(response, "语义索引没有完成"));
      const payload = await response.json() as { indexedEntryCount?: number; status?: "ready"; generationId?: string };
      if (payload.status !== "ready" || typeof payload.indexedEntryCount !== "number") throw new Error("服务端没有返回可验证的语义索引结果");
      setIndexedEntryCount(payload.indexedEntryCount);
      setConfirmation(null);
      setOverview({ status: "ready", label: "可用于语义搜索", indexedEntryCount: payload.indexedEntryCount, generationId: payload.generationId });
      setState("success");
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const message = cause instanceof Error ? cause.message : "语义索引没有完成";
      setError(message);
      onError?.(message);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  useEffect(() => () => requestRef.current?.abort(), []);

  const busy = state === "preparing" || state === "executing";
  const summary = confirmation?.safeSummary;
  const statusLabel = overviewLoading ? "读取中…" : overview?.label ?? "尚未建立/不可用";

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="personal-semantic-index-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Personal semantic index</p>
          <h3 id="personal-semantic-index-title" className="mt-2 text-lg font-semibold text-slate-900">建立个人语义索引</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">索引只属于当前账号，内容或向量模型配置变化后会自动失效。建立前会展示完整范围，确认后才会发送片段到你的个人向量模型。</p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${overview?.status === "ready" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{statusLabel}</span>
      </div>

      <div className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 px-3 py-3"><span className="block text-slate-400">索引片段</span><span className="mt-1 block text-sm font-semibold text-slate-900">{indexedEntryCount === null ? "—" : indexedEntryCount}</span></div>
        <div className="rounded-xl bg-slate-50 px-3 py-3"><span className="block text-slate-400">向量维度</span><span className="mt-1 block text-sm font-semibold text-slate-900">{overview?.dimensions === undefined ? "—" : `${overview.dimensions} 维`}</span></div>
        <div className="rounded-xl bg-slate-50 px-3 py-3"><span className="block text-slate-400">最近完成</span><span className="mt-1 block text-sm font-semibold text-slate-900">{formatDate(overview?.completedAt)}</span></div>
      </div>
      {overviewError !== null ? <p className="mt-2 text-xs text-rose-700" role="alert">{overviewError}</p> : null}

      <div className="mt-4">
        <label className="block text-xs font-semibold text-slate-600" htmlFor="personal-semantic-index-provider">建立索引使用的个人向量模型</label>
        <select
          id="personal-semantic-index-provider"
          value={providerId ?? ""}
          onChange={(event) => setProviderId(event.target.value || null)}
          disabled={providersLoading || busy || state === "awaiting-confirmation"}
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:opacity-60"
        >
          <option value="">{providersLoading ? "正在读取已验证的个人向量模型…" : "请选择个人向量模型"}</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.defaultEmbeddingModelId} · {provider.embeddingDimensions} 维</option>)}
        </select>
        {providersError !== null ? <p className="mt-1 text-xs text-rose-700" role="alert">{providersError}</p> : null}
        {!providersLoading && providersError === null && providers.length === 0 ? <p className="mt-1 text-xs text-slate-500">没有可用的已验证个人向量模型，请先到“配置 · 我的模型”完成连接测试并配置向量模型。</p> : null}
      </div>

      <button type="button" onClick={() => void prepare()} disabled={busy || state === "awaiting-confirmation" || providersLoading || providerId === null} className="mt-4 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
        {state === "preparing" ? "检查个人知识范围…" : overview?.status === "ready" ? "重建语义索引" : "建立语义索引"}
      </button>

      {state === "awaiting-confirmation" && confirmation !== null && summary !== undefined ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4" role="dialog" aria-labelledby="personal-semantic-index-confirm-title">
          <h4 id="personal-semantic-index-confirm-title" className="text-sm font-semibold text-amber-950">确认建立个人语义索引</h4>
          <p className="mt-2 text-xs leading-5 text-amber-900">本次会向 {summary.provider.name} 的 {summary.provider.model} 发送 {summary.totalChunks} 个片段（{formatBytes(summary.totalSourceBytes)}），向量维度为 {summary.provider.dimensions}。</p>
          <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-amber-200 bg-white/70 p-2">
            <ul className="space-y-1.5" aria-label="本次语义索引范围">
              {summary.documents.map((document) => (
                <li key={document.documentId} className="rounded-md bg-white px-2.5 py-2 text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">{document.title}</span>
                  <span className="mt-1 block break-all font-mono text-[10px] text-slate-500">文档 {document.documentId} · 修订 {document.revisionId}</span>
                  <span className="mt-1 block text-slate-500">v{document.version} · {document.chunkCount} 个片段 · {formatBytes(document.sourceBytes)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-2 text-xs text-amber-800">确认有效期至 {formatExpiry(confirmation.expiresAt)}；内容或模型配置变化后需要重新建立。BYOK 请求不扣平台额度。</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={cancelConfirmation} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900">取消</button>
            <button type="button" onClick={() => void execute()} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800">确认并建立</button>
          </div>
        </div>
      ) : null}

      {state === "executing" ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600" role="status">正在请求个人向量模型并写入索引…</p> : null}
      {state === "success" ? <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-xs text-emerald-800" role="status">语义索引已建立，共写入 {indexedEntryCount ?? 0} 个片段，现在可以使用个人语义搜索。</p> : null}
      {error !== null ? <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700" role="alert">{error}</div> : null}
    </section>
  );
}
