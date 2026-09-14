"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CursorPagination } from "@/components/list-pagination";
import { KnowledgeLifecycle } from "@/components/knowledge-lifecycle";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { isReviewType, parseReviewType, type ReviewType } from "./materials/materials-navigation";

type Review = {
  source: "web" | "verified";
  id: string;
  createdAt: string;
  model: { providerName: string | null; providerKind: string | null; modelId: string };
  evidence: { sourceId: string; sourceKind: string; contentHash: string; excerpt: string };
  item: {
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    title: string;
    content: string;
    occurredAt: string | null;
    updatedAt: string;
  };
};

type CursorPage = { items: Review[]; nextCursor: string | null };

const itemLabels = { decision: "决策", progress: "进展", issue: "问题", risk: "风险" } as const;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error((await safeResponseError(response, `请求失败（${response.status}）`)).message);
  return await response.json() as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectMaterialReviewQueue({ projectId, onChanged }: { projectId: string; onChanged?: () => Promise<void> }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("materialsReview", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const cursor = navigation.cursor;
  const search = navigation.search ?? "";
  const deferredSearch = useDeferredValue(search);
  const itemType: ReviewType = parseReviewType(navigation.filter);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function replaceReviewQuery(input: { search?: string; type?: ReviewType; cursor?: string | null }): void {
    const nextSearch = input.search ?? navigation.search ?? "";
    const nextType = input.type ?? parseReviewType(navigation.filter);
    const nextCursor = input.cursor === undefined ? navigation.cursor : input.cursor;
    const href = buildProjectHref(projectId, "materialsReview", {
      search: nextSearch,
      filter: nextType,
      cursor: nextCursor,
      focus: "review-queue",
      from: navigation.from,
      returnTo: navigation.returnTo,
    });
    router.replace(href === pathname ? pathname : href, { scroll: false });
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      if (deferredSearch.trim()) query.set("search", deferredSearch.trim());
      if (itemType !== "all") query.set("itemType", itemType);
      const page = await readJson<CursorPage>(await fetch(`/api/projects/${projectId}/governance/reviews?${query}`, { cache: "no-store" }));
      setReviews(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "待审核候选加载失败");
    } finally {
      setLoading(false);
    }
  }, [cursor, deferredSearch, itemType, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (navigation.focus !== "review-queue" || loading) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById("review-queue");
      target?.scrollIntoView({ block: "start" });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, navigation.focus]);

  async function reviewCandidate(review: Review, action: "accept" | "dismiss") {
    const key = `${review.source}:${review.id}:${action}`;
    setPending(key);
    setError(null);
    setMessage(null);
    try {
      const endpoint = review.source === "web"
        ? `/api/projects/${projectId}/memory/candidates/${review.id}`
        : `/api/projects/${projectId}/ai-memory/candidates/${review.id}`;
      const body = review.source === "web" || action === "dismiss"
        ? { action, expectedItemUpdatedAt: review.item.updatedAt }
        : {
            action,
            expectedItemUpdatedAt: review.item.updatedAt,
            type: review.item.type,
            title: review.item.title,
            content: review.item.content,
            occurredAt: review.item.occurredAt,
          };
      await readJson(await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (reviews.length === 1 && history.length > 0) {
        const previous = history.at(-1) ?? null;
        setHistory((current) => current.slice(0, -1));
        replaceReviewQuery({ cursor: previous });
      } else {
        await load();
      }
      await onChanged?.();
      setMessage(action === "accept" ? "候选已确认并进入已确认事实；是否进入 AI 可引用记忆由后续流程决定。" : "候选已驳回，审核记录已保留。");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "审核失败，请刷新后重试");
      await load();
    } finally {
      setPending(null);
    }
  }

  return (
    <section id="review-queue" tabIndex={-1} aria-labelledby="review-queue-heading" className="mt-10 scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm outline-none focus:ring-4 focus:ring-indigo-100 sm:p-8">
      {navigation.returnTo ? <Link href={navigation.returnTo} className="mb-5 inline-flex text-sm font-semibold text-indigo-700">← 返回来源页面</Link> : null}
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">AI candidate review</p><h2 id="review-queue-heading" className="mt-2 text-2xl font-semibold tracking-tight">审核 AI 候选</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">AI 抽取结果仍是候选。核对原始资料证据后，确认操作只会将其推进为已确认事实，不会在这里直接承诺进入 AI 可引用记忆。</p></div>
        <span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">当前页 {reviews.length} 条</span>
      </div>
      <div className="mt-5"><KnowledgeLifecycle compact /></div>
      <div className="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_190px]">
        <label><span className="sr-only">搜索 AI 候选</span><input value={search} onChange={(event) => { const value = event.target.value; setHistory([]); replaceReviewQuery({ search: value, cursor: null }); }} placeholder="搜索候选标题、内容或证据" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>
        <label><span className="sr-only">按候选类型筛选</span><select value={itemType} onChange={(event) => { const value = isReviewType(event.target.value) ? event.target.value : "all"; setHistory([]); replaceReviewQuery({ type: value, cursor: null }); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all">全部类型</option><option value="decision">决策</option><option value="progress">进展</option><option value="issue">问题</option><option value="risk">风险</option></select></label>
      </div>
      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}
      {message ? <p role="status" className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700">{message}</p> : null}
      {loading ? <div className="mt-6 h-40 animate-pulse rounded-2xl bg-slate-100" /> : reviews.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">{search.trim() || itemType !== "all" ? "没有匹配的 AI 候选。" : "当前没有待审核 AI 候选。"}</p> : <div className="mt-6 space-y-4">{reviews.map((review) => (
        <article key={`${review.source}:${review.id}`} className="rounded-2xl border border-slate-200 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">{itemLabels[review.item.type]}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{review.source === "web" ? "网页 AI" : "受控 AI"}</span></div><h3 className="mt-3 text-base font-semibold">{review.item.title}</h3></div><span className="text-xs text-slate-400">{formatDate(review.createdAt)}</span></div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{review.item.content}</p>
          <blockquote className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600 [overflow-wrap:anywhere]">{review.evidence.excerpt || "未提供证据摘录"}</blockquote>
          <p className="mt-3 text-[12px] text-slate-400 [overflow-wrap:anywhere]">{review.model.providerName ?? review.model.providerKind ?? "模型供应商未记录"} · {review.model.modelId} · Source {review.evidence.sourceKind}</p>
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void reviewCandidate(review, "accept")} disabled={pending !== null} className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-40">{pending === `${review.source}:${review.id}:accept` ? "确认中…" : "确认进入已确认事实"}</button><button type="button" onClick={() => void reviewCandidate(review, "dismiss")} disabled={pending !== null} className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">{pending === `${review.source}:${review.id}:dismiss` ? "驳回中…" : "驳回"}</button></div>
        </article>
      ))}</div>}
      <CursorPagination page={history.length + 1} hasPrevious={history.length > 0} hasNext={nextCursor !== null} disabled={loading || pending !== null} onPrevious={() => { const previous = history.at(-1) ?? null; setHistory((current) => current.slice(0, -1)); replaceReviewQuery({ cursor: previous }); }} onNext={() => { if (!nextCursor) return; setHistory((current) => [...current, cursor]); replaceReviewQuery({ cursor: nextCursor }); }} />
    </section>
  );
}
