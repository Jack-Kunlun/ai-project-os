"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
  action: "personalKnowledgeSemanticSearch";
  corpusEpoch: number;
  documents: readonly SemanticSummaryDocument[];
  totalChunks: number;
  totalSourceBytes: number;
  provider: Readonly<{ name: string; model: string; dimensions: number }>;
  expiresAt: string;
}>;

type SemanticConfirmation = Readonly<{
  challengeId: string;
  kind: "search";
  issuedAt: string;
  expiresAt: string;
  safeSummary: SemanticConfirmationSummary;
}>;

type SemanticSearchResult = Readonly<{
  rank: number;
  score: number;
  documentId: string;
  revisionId: string;
  version: number;
  title: string;
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
}>;

type SemanticSearchState = "idle" | "preparing" | "awaiting-confirmation" | "executing" | "success" | "error";

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

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date)
    : "稍后过期";
}

function randomClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `personal-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

/**
 * Search the owner scoped personal semantic index. The prepare and execute
 * calls stay separate so the exact source set and BYOK embedding provider are
 * visible before any external request is dispatched.
 */
export function PersonalSemanticSearchPanel({
  onError,
}: Readonly<{ onError?: (message: string) => void }>): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SemanticSearchState>("idle");
  const [confirmation, setConfirmation] = useState<SemanticConfirmation | null>(null);
  const [results, setResults] = useState<readonly SemanticSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly SemanticProvider[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const clientKeyRef = useRef(randomClientKey());

  useEffect(() => () => requestRef.current?.abort(), []);

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

  function resetConfirmation(): void {
    setConfirmation(null);
    setResults([]);
    setError(null);
    setState("idle");
  }

  async function prepare(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setError("请输入要搜索的内容。");
      setState("error");
      return;
    }
    if (providerId === null) {
      setError("请选择一个已验证且支持向量的个人模型后再搜索。");
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
    setResults([]);
    try {
      const response = await fetch("/api/personal/knowledge/semantic-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ phase: "prepare", providerId, clientKey: clientKeyRef.current, query: trimmed }),
      });
      if (!response.ok) throw new Error(await responseError(response, "当前还不能准备语义搜索"));
      const payload = await response.json() as { challengeId?: string; kind?: "search"; issuedAt?: string; expiresAt?: string; safeSummary?: SemanticConfirmationSummary };
      if (payload.challengeId === undefined || payload.kind !== "search" || payload.issuedAt === undefined || payload.expiresAt === undefined || payload.safeSummary === undefined) {
        throw new Error("服务端没有返回完整的语义搜索确认摘要");
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
      const message = cause instanceof Error ? cause.message : "当前还不能准备语义搜索";
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
      const response = await fetch("/api/personal/knowledge/semantic-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          phase: "execute",
          challengeId: confirmation.challengeId,
          clientKey: clientKeyRef.current,
          query: query.trim(),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "语义搜索没有完成"));
      const payload = await response.json() as { results?: readonly SemanticSearchResult[] };
      if (!Array.isArray(payload.results)) throw new Error("服务端没有返回可验证的搜索结果");
      setResults(payload.results);
      setConfirmation(null);
      setState("success");
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const message = cause instanceof Error ? cause.message : "语义搜索没有完成";
      setError(message);
      onError?.(message);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  const busy = state === "preparing" || state === "executing";
  const confirmationSummary = confirmation?.safeSummary;

  return (
    <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-5 shadow-sm sm:p-6" aria-labelledby="personal-semantic-search-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Semantic search</p>
          <h3 id="personal-semantic-search-title" className="mt-2 text-lg font-semibold text-slate-900">搜索我的知识库</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">只检索当前个人知识版本。发送前会列出完整文档范围、片段数量和个人向量模型，并需要你单独确认。</p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700">BYOK · 不扣平台额度</span>
      </div>

      <form onSubmit={prepare} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="sr-only">搜索个人知识库</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={1_000}
            disabled={busy || state === "awaiting-confirmation"}
            placeholder="例如：哪些页面记录了发布前检查？"
            className="w-full rounded-xl border border-indigo-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:opacity-60"
          />
        </label>
        <button type="submit" disabled={busy || state === "awaiting-confirmation" || providersLoading || providerId === null} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
          {state === "preparing" ? "检查索引中…" : "准备搜索"}
        </button>
      </form>

      <div className="mt-3">
        <label className="block text-xs font-semibold text-slate-600" htmlFor="personal-semantic-provider">发送到个人向量模型</label>
        <select
          id="personal-semantic-provider"
          value={providerId ?? ""}
          onChange={(event) => { setProviderId(event.target.value || null); resetConfirmation(); }}
          disabled={providersLoading || busy || state === "awaiting-confirmation"}
          className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:opacity-60"
        >
          <option value="">{providersLoading ? "正在读取已验证的个人向量模型…" : "请选择个人向量模型"}</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.defaultEmbeddingModelId} · {provider.embeddingDimensions} 维</option>)}
        </select>
        {providersError !== null ? <p className="mt-1 text-xs text-rose-700" role="alert">{providersError}</p> : null}
        {!providersLoading && providersError === null && providers.length === 0 ? <p className="mt-1 text-xs text-slate-500">没有可用的已验证个人向量模型，请先到“配置 · 我的模型”完成连接测试并配置向量模型。</p> : null}
      </div>

      {state === "awaiting-confirmation" && confirmation !== null && confirmationSummary !== undefined ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4" role="dialog" aria-labelledby="personal-semantic-confirm-title">
          <h4 id="personal-semantic-confirm-title" className="text-sm font-semibold text-amber-950">确认发送语义搜索请求</h4>
          <p className="mt-2 text-xs leading-5 text-amber-900">本次会向 {confirmationSummary.provider.name} 的 {confirmationSummary.provider.model} 发送 1 条搜索向量请求。索引范围共 {confirmationSummary.documents.length} 个文档、{confirmationSummary.totalChunks} 个片段（{formatBytes(confirmationSummary.totalSourceBytes)}）。</p>
          <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-amber-200 bg-white/70 p-2">
            <ul className="space-y-1.5" aria-label="本次语义搜索索引范围">
              {confirmationSummary.documents.map((document) => (
                <li key={document.documentId} className="rounded-md bg-white px-2.5 py-2 text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">{document.title}</span>
                  <span className="mt-1 block break-all font-mono text-[10px] text-slate-500">文档 {document.documentId} · 修订 {document.revisionId}</span>
                  <span className="mt-1 block text-slate-500">v{document.version} · {document.chunkCount} 个片段 · {formatBytes(document.sourceBytes)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-2 text-xs text-amber-800">确认有效期至 {formatExpiry(confirmation.expiresAt)}；知识内容或模型配置变化后需要重新准备。搜索结果只会引用执行时仍是当前版本的内容。</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={resetConfirmation} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900">取消</button>
            <button type="button" onClick={() => void execute()} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800">确认并搜索</button>
          </div>
        </div>
      ) : null}

      {state === "executing" ? <p className="mt-4 rounded-xl bg-white px-4 py-3 text-xs text-slate-600" role="status">正在请求个人向量模型并校验当前版本引用…</p> : null}
      {error !== null ? <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700" role="alert">{error}</div> : null}
      {state === "success" && results.length === 0 ? <p className="mt-4 rounded-xl bg-white px-4 py-3 text-xs text-slate-600" role="status">没有找到可验证的相关内容。</p> : null}
      {results.length > 0 ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-white px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-slate-900">搜索结果</h4>
            <span className="text-xs text-slate-500">{results.length} 条 · 当前版本</span>
          </div>
          <ol className="mt-3 space-y-2">
            {results.map((result) => (
              <li key={`${result.documentId}:${result.revisionId}:${result.rangeStart}`} className="rounded-lg bg-slate-50 px-3 py-3 text-xs text-slate-700">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-indigo-700">#{result.rank}</span>
                  <span className="font-semibold text-slate-900">{result.title}</span>
                  <span className="text-slate-500">相似度 {formatScore(result.score)}</span>
                  <span className="text-slate-500">v{result.version} · 字节 {result.rangeStart}–{result.rangeEnd}</span>
                </div>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-500">文档 {result.documentId} · 修订 {result.revisionId}</p>
                <p className="mt-2 whitespace-pre-wrap leading-5 text-slate-600">{result.excerpt}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
