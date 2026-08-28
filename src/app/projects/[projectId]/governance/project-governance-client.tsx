"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";

type Summary = {
  project: { id: string; name: string };
  pendingReviews: { web: number; verified: number; total: number };
  jobs: { reconciliationRequired: number; failed: number };
  github: { partial: number; rateLimited: number; unknown: number };
  index: { readiness: string; compatible: boolean; activeRecordCount: number; publishedAt: string | null };
  latestIndexInvalidation: { id: string; operation: string; createdAt: string } | null;
  attentionTotal: number;
};

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

type Operation = {
  id: string;
  kind: string;
  status: string;
  stage: string;
  result: unknown;
  progressCurrent: number;
  progressTotal: number;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: string;
  completedAt: string | null;
  capability: { action: "reconcile" | "cancel" | null; reason: string };
  destination: string;
  githubSync: null | {
    id: string;
    status: string;
    warnings: string[];
    failureCode: string | null;
    counts: { added: number; updated: number; deleted: number; withheld: number };
  };
};

type RouteRevision = {
  id: string;
  operation: string;
  previous: null | { providerName: string | null; providerKind: string | null; modelId: string; embeddingDimensions: number | null; maxOutputTokens: number | null };
  current: { providerName: string; providerKind: string; modelId: string; embeddingDimensions: number | null; maxOutputTokens: number };
  onlyFutureRuns: boolean;
  indexInvalidated: boolean;
  activeIndexGenerationId: string | null;
  actor: string;
  createdAt: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

type UsageBreakdown = {
  recordCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  succeededRequests: number;
  failedRequests: number;
  unknownRequests: number;
  runningRequests: number;
};

type Usage = {
  period: { days: 7 | 30 | 90; start: string; end: string };
  totals: UsageBreakdown;
  byProvider: Array<UsageBreakdown & { providerName: string; providerKind: string; modelId: string; source: "current" | "legacy" }>;
  byOperation: Array<UsageBreakdown & { operation: string }>;
  pricing: { available: false; reason: string };
  sources: { current: string; legacy: string };
};

const itemLabels = { decision: "决策", progress: "进展", issue: "问题", risk: "风险" } as const;
const jobLabels: Record<string, string> = {
  githubScan: "仓库代码扫描",
  githubMaterialSync: "仓库资料同步",
  githubProjectSync: "项目 GitHub 同步",
  memoryIndex: "语义索引",
  autoExtract: "自动抽取",
  semanticSearch: "语义检索",
  ragAnswer: "引用式问答",
  projectBrief: "项目简报",
  projectAgent: "项目智能体",
};
const statusLabels: Record<string, string> = {
  queued: "排队中",
  waitingConsent: "等待确认",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未知",
  cancelled: "已取消",
  partial: "部分完成",
  rateLimited: "被限流",
};
const readinessLabels: Record<string, string> = {
  ready: "索引就绪",
  routeMissing: "未配置向量路由",
  providerUnavailable: "向量供应商不可用",
  indexMissing: "尚未建立索引",
  legacyIndex: "旧版索引需全量重建",
  routeIncompatible: "索引与当前路由不兼容",
  inputsChanged: "资料已变化，索引待重建",
};
const operationLabels: Record<string, string> = {
  embedding: "语义向量",
  autoExtract: "自动抽取",
  sourceSummary: "资料总结",
  projectAnalysis: "项目分析",
  generateWithContext: "引用式生成",
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
  return payload as T;
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function statusTone(status: string): string {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (status === "unknown" || status === "partial" || status === "rateLimited") return "bg-amber-50 text-amber-800";
  if (status === "failed") return "bg-rose-50 text-rose-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-600";
  return "bg-indigo-50 text-indigo-700";
}

export function ProjectGovernanceClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
  const [routes, setRoutes] = useState<RouteRevision[]>([]);
  const [routeCursor, setRouteCursor] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageDays, setUsageDays] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    const payload = await readJson<{ summary: Summary }>(await fetch(`/api/projects/${projectId}/governance`, { cache: "no-store" }));
    setSummary(payload.summary);
  }, [projectId]);

  const fetchReviews = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    const page = await readJson<Page<Review>>(await fetch(`/api/projects/${projectId}/governance/reviews?${query}`, { cache: "no-store" }));
    setReviews((current) => append ? [...current, ...page.items] : page.items);
    setReviewCursor(page.nextCursor);
  }, [projectId]);

  const fetchOperations = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    const page = await readJson<Page<Operation>>(await fetch(`/api/projects/${projectId}/governance/operations?${query}`, { cache: "no-store" }));
    setOperations((current) => append ? [...current, ...page.items] : page.items);
    setOperationCursor(page.nextCursor);
  }, [projectId]);

  const fetchRoutes = useCallback(async (cursor?: string, append = false) => {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    const page = await readJson<Page<RouteRevision>>(await fetch(`/api/projects/${projectId}/governance/routes?${query}`, { cache: "no-store" }));
    setRoutes((current) => append ? [...current, ...page.items] : page.items);
    setRouteCursor(page.nextCursor);
  }, [projectId]);

  const fetchUsage = useCallback(async (days: 7 | 30 | 90) => {
    const payload = await readJson<{ usage: Usage }>(await fetch(`/api/projects/${projectId}/governance/usage?days=${days}`, { cache: "no-store" }));
    setUsage(payload.usage);
  }, [projectId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchSummary(), fetchReviews(), fetchOperations(), fetchRoutes(), fetchUsage(usageDays)]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "治理数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [fetchOperations, fetchReviews, fetchRoutes, fetchSummary, fetchUsage, usageDays]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  async function reviewCandidate(review: Review, action: "accept" | "dismiss") {
    const key = `${review.source}:${review.id}:${action}`;
    setPending(key);
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
      await Promise.all([fetchSummary(), fetchReviews()]);
      setMessage(action === "accept" ? "候选已确认并进入项目事实。" : "候选已驳回，审核记录已保留。");
    } catch (reviewError) {
      await Promise.allSettled([fetchSummary(), fetchReviews()]);
      setMessage(reviewError instanceof Error ? reviewError.message : "审核失败，请刷新后重试");
    } finally {
      setPending(null);
    }
  }

  async function actOnJob(operation: Operation) {
    if (operation.capability.action === null) return;
    const action = operation.capability.action;
    setPending(`${operation.id}:${action}`);
    setMessage(null);
    try {
      await readJson(await fetch(`/api/projects/${projectId}/jobs/${operation.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      }));
      await Promise.all([fetchSummary(), fetchOperations()]);
      setMessage(action === "reconcile" ? "未知结果已按对应任务规则人工收口；系统未自动重试。" : "尚未执行的任务已取消。");
    } catch (actionError) {
      await Promise.allSettled([fetchSummary(), fetchOperations()]);
      setMessage(actionError instanceof Error ? actionError.message : "任务操作失败，请刷新后重试");
    } finally {
      setPending(null);
    }
  }

  async function loadMore(kind: "reviews" | "operations" | "routes") {
    setLoadingMore(kind);
    try {
      if (kind === "reviews" && reviewCursor) await fetchReviews(reviewCursor, true);
      if (kind === "operations" && operationCursor) await fetchOperations(operationCursor, true);
      if (kind === "routes" && routeCursor) await fetchRoutes(routeCursor, true);
    } catch (moreError) {
      setMessage(moreError instanceof Error ? moreError.message : "加载更多失败");
    } finally {
      setLoadingMore(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="governance" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-10 sm:px-8 lg:px-10">
        <section className="flex flex-wrap items-end justify-between gap-5 pb-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Governance & review</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">治理与审核</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">统一查看待审核事实、未知结果、GitHub 同步风险、索引状态与模型路由变更。这里不会自动重试任务、重建索引或接受候选。</p>
          </div>
          <button type="button" onClick={() => void reload()} disabled={loading} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-40">刷新事实状态</button>
        </section>

        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {message ? <div role="status" className="mb-6 rounded-2xl border border-indigo-100 bg-indigo-50 px-5 py-4 text-sm text-indigo-800">{message}</div> : null}
        {loading || summary === null ? <div className="h-44 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <Metric label="待审核" value={summary.pendingReviews.total} detail={`网页 ${summary.pendingReviews.web} · 已验证 ${summary.pendingReviews.verified}`} tone={summary.pendingReviews.total > 0 ? "amber" : "slate"} />
              <Metric label="待人工收口" value={summary.jobs.reconciliationRequired} detail="unknown 不等同失败或成功" tone={summary.jobs.reconciliationRequired > 0 ? "rose" : "slate"} />
              <Metric label="失败任务" value={summary.jobs.failed} detail="仅查看；重新执行需回原页面" tone={summary.jobs.failed > 0 ? "rose" : "slate"} />
              <Metric label="GitHub 风险" value={summary.github.partial + summary.github.rateLimited + summary.github.unknown} detail={`部分 ${summary.github.partial} · 限流 ${summary.github.rateLimited} · 未知 ${summary.github.unknown}`} tone={summary.github.unknown > 0 ? "rose" : "amber"} />
              <Metric label="语义索引" value={readinessLabels[summary.index.readiness] ?? summary.index.readiness} detail={`${summary.index.activeRecordCount} 条活动记忆`} tone={summary.index.compatible ? "emerald" : "amber"} />
            </section>

            <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
                <SectionHeader eyebrow="Model usage" title="模型用量" description="现行调用审计按每次供应商请求计数；旧运行台账按 requestCount 汇总，两者来源独立，不重复计数。" border={false} />
                <div className="flex rounded-xl bg-slate-100 p-1" aria-label="用量统计周期">{([7, 30, 90] as const).map((days) => <button key={days} type="button" onClick={() => setUsageDays(days)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${usageDays === days ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>{days} 天</button>)}</div>
              </div>
              {usage === null ? <div className="mt-6 h-32 animate-pulse rounded-2xl bg-slate-100" /> : (
                <>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <UsageMetric label="供应商请求" value={formatNumber(usage.totals.requestCount)} detail={`${formatNumber(usage.totals.recordCount)} 条审计/运行记录`} />
                    <UsageMetric label="输入 Token" value={formatNumber(usage.totals.inputTokens)} detail={`周期始于 ${formatDate(usage.period.start)}`} />
                    <UsageMetric label="输出 Token" value={formatNumber(usage.totals.outputTokens)} detail={`合计 ${formatNumber(usage.totals.totalTokens)} Token`} />
                    <UsageMetric label="异常请求" value={formatNumber(usage.totals.failedRequests + usage.totals.unknownRequests)} detail={`失败 ${formatNumber(usage.totals.failedRequests)} · 未知 ${formatNumber(usage.totals.unknownRequests)}`} />
                  </div>
                  <div className="mt-6 grid gap-5 lg:grid-cols-2">
                    <UsageList title="按供应商与模型" empty="当前周期没有模型调用。" items={usage.byProvider.map((entry) => ({ key: `${entry.source}:${entry.providerKind}:${entry.modelId}`, label: `${entry.providerName} · ${entry.modelId}`, detail: `${entry.source === "legacy" ? "旧运行台账" : entry.providerKind} · ${formatNumber(entry.requestCount)} 次`, value: `${formatNumber(entry.totalTokens)} Token` }))} />
                    <UsageList title="按能力" empty="当前周期没有能力用量。" items={usage.byOperation.map((entry) => ({ key: entry.operation, label: operationLabels[entry.operation] ?? entry.operation, detail: `${formatNumber(entry.requestCount)} 次请求`, value: `${formatNumber(entry.totalTokens)} Token` }))} />
                  </div>
                  <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{usage.pricing.reason}。这里展示可核对的请求与 Token，不把 Token 直接换算为金额。</p>
                </>
              )}
            </section>

            <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <SectionHeader eyebrow="Human review" title="待审核候选" description="逐条核对内容与原文摘录。接受后才成为项目事实；页面不提供批量接受。" />
              {reviews.length === 0 ? <Empty text="当前没有待审核候选。" /> : <div className="mt-6 grid gap-4 lg:grid-cols-2">{reviews.map((review) => (
                <article key={`${review.source}:${review.id}`} className="flex flex-col rounded-2xl border border-slate-200 p-5">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-semibold text-indigo-700">{itemLabels[review.item.type]}</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">{review.source === "web" ? "网页自动抽取" : "已验证 AI 运行"}</span>
                    <span className="text-slate-400">{review.model.providerName ?? "冻结运行"} · {review.model.modelId}</span>
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">{review.item.title}</h3>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{review.item.content}</p>
                  <blockquote className="mt-4 rounded-xl border-l-2 border-indigo-300 bg-indigo-50/60 px-4 py-3 text-xs leading-5 text-slate-600">{review.evidence.excerpt}</blockquote>
                  <p className="mt-3 break-all text-[11px] text-slate-400">{review.evidence.sourceKind} · SHA-256 {review.evidence.contentHash.slice(0, 16)}… · {formatDate(review.createdAt)}</p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void reviewCandidate(review, "accept")} disabled={pending !== null} className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-40">{pending === `${review.source}:${review.id}:accept` ? "确认中…" : "确认记忆"}</button>
                    <button type="button" onClick={() => void reviewCandidate(review, "dismiss")} disabled={pending !== null} className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">{pending === `${review.source}:${review.id}:dismiss` ? "驳回中…" : "驳回"}</button>
                  </div>
                </article>
              ))}</div>}
              {reviewCursor ? <MoreButton pending={loadingMore === "reviews"} onClick={() => void loadMore("reviews")} /> : null}
            </section>

            <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <SectionHeader eyebrow="Recoverable operations" title="任务异常与人工收口" description="未知结果不会自动重试。只有具备对应不可变证据的任务才显示人工收口动作。" />
              {operations.length === 0 ? <Empty text="当前没有项目任务。" /> : <div className="mt-6 divide-y divide-slate-100">{operations.map((operation) => (
                <article key={operation.id} className="flex flex-wrap items-start justify-between gap-4 py-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{jobLabels[operation.kind] ?? operation.kind}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusTone(operation.githubSync?.status ?? operation.status)}`}>{statusLabels[operation.githubSync?.status ?? operation.status] ?? (operation.githubSync?.status ?? operation.status)}</span></div>
                    <p className="mt-2 text-xs text-slate-400">{formatDate(operation.createdAt)} · {operation.stage}{operation.failureCode ? ` · ${operation.failureCode}` : ""}</p>
                    {operation.status === "unknown" ? <p className="mt-2 text-xs leading-5 text-amber-800">结果未知，不代表成功或失败。{operation.capability.reason === "specializedReconciliationRequired" ? "该旧式 GitHub 任务仍有子运行阻塞，当前只能查看，不能用通用对账关闭。" : operation.reconciliationRequired ? "可按该任务的专用规则人工收口；不会触发外部调用。" : "该未知结果已由人工收口，状态仍保留为未知。"}</p> : null}
                    {operation.githubSync ? <p className="mt-2 text-xs text-slate-500">GitHub：新增 {operation.githubSync.counts.added} · 更新 {operation.githubSync.counts.updated} · 删除 {operation.githubSync.counts.deleted} · 保留 {operation.githubSync.counts.withheld}</p> : null}
                    {operation.githubSync?.warnings.length ? <p className="mt-2 text-xs leading-5 text-amber-700">{operation.githubSync.warnings.join(" · ")}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={operation.destination} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">查看详情</Link>
                    {operation.capability.action ? <button type="button" onClick={() => void actOnJob(operation)} disabled={pending !== null} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 disabled:opacity-40">{pending === `${operation.id}:${operation.capability.action}` ? "处理中…" : operation.capability.action === "reconcile" ? "人工收口" : "取消任务"}</button> : null}
                  </div>
                </article>
              ))}</div>}
              {operationCursor ? <MoreButton pending={loadingMore === "operations"} onClick={() => void loadMore("operations")} /> : null}
            </section>

            <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <SectionHeader eyebrow="Immutable audit" title="模型路由变更记录" description="这里只显示已发生的路由修订，不提供编辑或回滚动作。切换模型不会改写历史记忆。" />
              {routes.length === 0 ? <Empty text="当前没有模型路由变更记录。" /> : <div className="mt-6 space-y-3">{routes.map((route) => (
                <article key={route.id} className="rounded-2xl border border-slate-200 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{route.operation}</span>{route.indexInvalidated ? <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">索引已失效</span> : null}</div><span className="text-xs text-slate-400">{formatDate(route.createdAt)} · {route.actor}</span></div>
                  <div className="mt-4 grid gap-3 text-xs sm:grid-cols-[1fr_auto_1fr]"><RouteBox label="原路由" route={route.previous} /><span className="hidden self-center text-slate-300 sm:block">→</span><RouteBox label="新路由" route={route.current} /></div>
                  {route.indexInvalidated ? <p className="mt-3 text-xs text-amber-800">现有索引未被改写；请前往 <Link href={`/projects/${projectId}/memory`} className="font-semibold underline">智能记忆</Link> 显式重建。</p> : null}
                </article>
              ))}</div>}
              {routeCursor ? <MoreButton pending={loadingMore === "routes"} onClick={() => void loadMore("routes")} /> : null}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone: "slate" | "amber" | "rose" | "emerald" }) {
  const tones = { slate: "border-slate-200 bg-white", amber: "border-amber-200 bg-amber-50", rose: "border-rose-200 bg-rose-50", emerald: "border-emerald-200 bg-emerald-50" } as const;
  return <article className={`rounded-2xl border p-5 shadow-sm ${tones[tone]}`}><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p><p className="mt-2 text-[11px] leading-5 text-slate-500">{detail}</p></article>;
}

function SectionHeader({ eyebrow, title, description, border = true }: { eyebrow: string; title: string; description: string; border?: boolean }) {
  return <div className={border ? "border-b border-slate-100 pb-5" : ""}><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{eyebrow}</p><h2 className="mt-2 text-2xl font-semibold">{title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{description}</p></div>;
}

function UsageMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p><p className="mt-2 text-[11px] leading-5 text-slate-400">{detail}</p></article>;
}

function UsageList({ title, empty, items }: { title: string; empty: string; items: Array<{ key: string; label: string; detail: string; value: string }> }) {
  return <div className="rounded-2xl border border-slate-200 p-5"><h3 className="text-sm font-semibold text-slate-700">{title}</h3>{items.length === 0 ? <p className="mt-4 text-xs text-slate-400">{empty}</p> : <div className="mt-3 divide-y divide-slate-100">{items.slice(0, 8).map((item) => <div key={item.key} className="flex items-center justify-between gap-4 py-3"><div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-700">{item.label}</p><p className="mt-1 text-[11px] text-slate-400">{item.detail}</p></div><span className="shrink-0 text-xs font-semibold text-slate-600">{item.value}</span></div>)}</div>}</div>;
}

function Empty({ text }: { text: string }) {
  return <p className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">{text}</p>;
}

function MoreButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} disabled={pending} className="mt-5 w-full rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 disabled:opacity-40">{pending ? "加载中…" : "加载更多"}</button>;
}

function RouteBox({ label, route }: { label: string; route: RouteRevision["previous"] | RouteRevision["current"] }) {
  if (route === null) return <div className="rounded-xl bg-slate-50 p-4"><p className="font-semibold text-slate-500">{label}</p><p className="mt-2 text-slate-400">首次配置</p></div>;
  return <div className="rounded-xl bg-slate-50 p-4"><p className="font-semibold text-slate-500">{label}</p><p className="mt-2 font-semibold text-slate-700">{route.providerName ?? route.providerKind ?? "已移除供应商"}</p><p className="mt-1 break-all text-slate-500">{route.modelId}{route.embeddingDimensions ? ` · ${route.embeddingDimensions} 维` : ""}</p></div>;
}
