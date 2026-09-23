"use client";

import { useEffect, useRef, useState } from "react";
import { safeResponseError } from "@/lib/safe-error-presentation";

type QaCitation = Readonly<{
  citationKey: string;
  title: string;
  rangeStart: number;
  rangeEnd: number;
  excerpt: string;
}>;

type QaConfirmationSummary = Readonly<{
  documentBytes: number;
  evidenceChunks: number;
  evidenceBytes: number;
  provider: string;
  model: string;
  expiresAt?: string;
}>;

type QaConfirmation = Readonly<{
  challengeId: string;
  providerId: string;
  expiresAt: string;
  safeSummary: QaConfirmationSummary;
}>;

type QaAnswer = Readonly<{
  answer: string;
  citations: readonly QaCitation[];
}>;

type QaProvider = Readonly<{
  id: string;
  name: string;
  status: string;
  disabledAt: string | null;
  defaultGenerationModelId: string | null;
}>;

type QaState = "idle" | "preparing" | "awaiting-confirmation" | "executing" | "success" | "error";

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
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date) : "稍后过期";
}

function randomClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `personal-qa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Ask one current personal page a grounded question. Prepare and execute are
 * deliberately separate so the user sees the exact outbound summary before
 * the BYOK provider request is dispatched.
 */
export function PersonalKnowledgeQaPanel({
  documentId,
  version,
  onError,
}: Readonly<{ documentId: string; version: number; onError?: (message: string) => void }>): React.JSX.Element {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<QaState>("idle");
  const [confirmation, setConfirmation] = useState<QaConfirmation | null>(null);
  const [answer, setAnswer] = useState<QaAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly QaProvider[]>([]);
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
        if (!response.ok) throw new Error(await responseError(response, "个人模型列表暂时不可用"));
        const payload = await response.json() as { providers?: readonly QaProvider[] };
        const available = (payload.providers ?? []).filter((provider) => provider.status === "verified" && provider.disabledAt === null && provider.defaultGenerationModelId !== null);
        setProviders(available);
        setProviderId((current) => current !== null && available.some((provider) => provider.id === current) ? current : (available[0]?.id ?? null));
        setProvidersError(null);
      } catch (cause) {
        if (controller.signal.aborted || isAbortError(cause)) return;
        const message = cause instanceof Error ? cause.message : "个人模型列表暂时不可用";
        setProvidersError(message);
      } finally {
        if (!controller.signal.aborted) setProvidersLoading(false);
      }
    }
    void loadProviders();
    return () => controller.abort();
  }, []);

  async function prepare(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 2) {
      setError("请先输入至少 2 个字符的问题。");
      setState("error");
      return;
    }
    if (providerId === null) {
      setError("请选择一个已验证的个人生成模型后再准备问答。");
      setState("error");
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    clientKeyRef.current = randomClientKey();
    setState("preparing");
    setError(null);
    setAnswer(null);
    setConfirmation(null);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(documentId)}/qa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ phase: "prepare", question: trimmed, providerId, clientKey: clientKeyRef.current }),
      });
      if (!response.ok) throw new Error(await responseError(response, "当前页面暂时不能发起问答"));
      const payload = await response.json() as { confirmation?: QaConfirmation };
      if (payload.confirmation === undefined) throw new Error("服务端没有返回问答确认摘要");
      setConfirmation(payload.confirmation);
      setState("awaiting-confirmation");
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const message = cause instanceof Error ? cause.message : "当前页面暂时不能发起问答";
      setError(message);
      onError?.(message);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  async function execute(): Promise<void> {
    if (confirmation === null || state === "executing") return;
    if (confirmation.providerId !== providerId) {
      setConfirmation(null);
      setState("idle");
      setError("个人模型选择已经变化，请重新准备问答。");
      clientKeyRef.current = randomClientKey();
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState("executing");
    setError(null);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(documentId)}/qa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          phase: "execute",
          challengeId: confirmation.challengeId,
          providerId: confirmation.providerId,
          clientKey: clientKeyRef.current,
          question: question.trim(),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "问答没有完成"));
      const payload = await response.json() as { answer?: QaAnswer };
      if (payload.answer === undefined) throw new Error("服务端没有返回带引用的回答");
      setAnswer(payload.answer);
      setConfirmation(null);
      setState("success");
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      const message = cause instanceof Error ? cause.message : "问答没有完成";
      setError(message);
      onError?.(message);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  function cancelConfirmation(): void {
    setConfirmation(null);
    setState("idle");
    setError(null);
  }

  function invalidateConfirmation(): void {
    if (confirmation === null) return;
    setConfirmation(null);
    setState("idle");
    setError(null);
    clientKeyRef.current = randomClientKey();
  }

  return (
    <section className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-5 py-5" aria-labelledby="personal-page-qa-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Page Q&amp;A</p>
          <h3 id="personal-page-qa-title" className="mt-2 text-lg font-semibold text-slate-900">问问这页内容</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">只使用当前版本 v{version} 的词法命中片段。发送前会列出页面字节数、证据片段和模型，并需要你单独确认。</p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700">BYOK · 不扣平台额度</span>
      </div>

      <form onSubmit={prepare} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="sr-only">询问当前个人知识页面</span>
          <input value={question} onChange={(event) => { setQuestion(event.target.value); invalidateConfirmation(); }} maxLength={2_000} disabled={state === "preparing" || state === "executing"} placeholder="例如：这页内容的发布前检查是什么？" className="w-full rounded-xl border border-indigo-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:opacity-60" />
        </label>
        <button type="submit" disabled={state === "preparing" || state === "executing" || providersLoading || providerId === null} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">{state === "preparing" ? "检查证据中…" : "准备问答"}</button>
      </form>

      <div className="mt-3">
        <label className="block text-xs font-semibold text-slate-600" htmlFor="personal-qa-provider">发送到个人模型</label>
        <select id="personal-qa-provider" value={providerId ?? ""} onChange={(event) => { setProviderId(event.target.value || null); invalidateConfirmation(); }} disabled={providersLoading || state === "preparing" || state === "executing"} className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:opacity-60">
          <option value="">{providersLoading ? "正在读取已验证的个人模型…" : "请选择个人模型"}</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.defaultGenerationModelId}</option>)}
        </select>
        {providersError !== null ? <p className="mt-1 text-xs text-rose-700" role="alert">{providersError}</p> : null}
        {!providersLoading && providersError === null && providers.length === 0 ? <p className="mt-1 text-xs text-slate-500">没有可用的已验证个人生成模型，请先到“配置 · 我的模型”完成连接测试。</p> : null}
      </div>

      {state === "awaiting-confirmation" && confirmation !== null ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4" role="dialog" aria-labelledby="personal-qa-confirm-title">
          <h4 id="personal-qa-confirm-title" className="text-sm font-semibold text-amber-950">确认发送当前页面</h4>
          <p className="mt-2 text-xs leading-5 text-amber-900">本次将发送页面 {formatBytes(confirmation.safeSummary.documentBytes)} 中的 {confirmation.safeSummary.evidenceChunks} 个证据片段（{formatBytes(confirmation.safeSummary.evidenceBytes)}），使用 {confirmation.safeSummary.provider} / {confirmation.safeSummary.model}。确认后才会请求你的个人模型。</p>
          <p className="mt-2 text-xs text-amber-800">确认有效期至 {formatExpiry(confirmation.expiresAt)}；页面内容或配置变化后需要重新准备。</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={cancelConfirmation} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900">取消</button>
            <button type="button" onClick={() => void execute()} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800">确认并发送</button>
          </div>
        </div>
      ) : null}

      {state === "executing" ? <p className="mt-4 rounded-xl bg-white px-4 py-3 text-xs text-slate-600" role="status">正在请求个人模型并校验引用…</p> : null}
      {error !== null ? <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700" role="alert">{error}</div> : null}
      {answer !== null ? (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-white px-4 py-4">
          <h4 className="text-sm font-semibold text-slate-900">回答</h4>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{answer.answer}</p>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-xs font-semibold text-slate-500">引用</p>
            <ul className="mt-2 space-y-2">
              {answer.citations.map((citation) => <li key={citation.citationKey} className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"><span className="font-semibold text-indigo-700">[{citation.citationKey}]</span> {citation.title} · 字符 {citation.rangeStart}–{citation.rangeEnd}<span className="mt-1 block line-clamp-2 text-slate-500">{citation.excerpt}</span></li>)}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
