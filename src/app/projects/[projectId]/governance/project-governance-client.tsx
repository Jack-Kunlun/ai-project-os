"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { CursorPagination } from "@/components/list-pagination";

type Summary = {
  project: { id: string; name: string };
  pendingReviews: { web: number; verified: number; total: number };
  jobs: { reconciliationRequired: number; failed: number };
  github: { partial: number; rateLimited: number; unknown: number };
  index: { readiness: string; compatible: boolean; activeRecordCount: number; publishedAt: string | null };
  latestIndexInvalidation: { id: string; operation: string; createdAt: string } | null;
  attentionTotal: number;
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

type CurrentRoute = {
  operation: string;
  providerConnectionId: string;
  providerName: string;
  providerKind: string;
  providerStatus: string;
  modelId: string;
  balanceAvailable: boolean;
};

type ProviderBalance = {
  providerConnectionId: string;
  providerName: string;
  providerKind: "deepseek";
  isAvailable: boolean;
  balances: Array<{ currency: "CNY" | "USD"; total: string; granted: string; toppedUp: string }>;
  fetchedAt: string;
};

type Usage = {
  period: { days: 7 | 30 | 90; start: string; end: string };
  totals: UsageBreakdown;
  routes: CurrentRoute[];
  byProvider: Array<UsageBreakdown & { providerName: string; providerKind: string; modelId: string; source: "current" | "legacy" }>;
  byOperation: Array<UsageBreakdown & { operation: string }>;
  pricing: { available: false; reason: string };
  sources: { current: string; legacy: string };
};

const jobLabels: Record<string, string> = {
  assetExtract: "文件图片识别",
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
  visionExtract: "图片与扫描件识别",
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
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
  const [operationNextCursor, setOperationNextCursor] = useState<string | null>(null);
  const [operationHistory, setOperationHistory] = useState<Array<string | null>>([]);
  const [operationSearch, setOperationSearch] = useState("");
  const deferredOperationSearch = useDeferredValue(operationSearch);
  const [operationKind, setOperationKind] = useState("all");
  const [operationStatus, setOperationStatus] = useState("all");
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [routes, setRoutes] = useState<RouteRevision[]>([]);
  const [routeCursor, setRouteCursor] = useState<string | null>(null);
  const [routeNextCursor, setRouteNextCursor] = useState<string | null>(null);
  const [routeHistory, setRouteHistory] = useState<Array<string | null>>([]);
  const [routeSearch, setRouteSearch] = useState("");
  const deferredRouteSearch = useDeferredValue(routeSearch);
  const [routeOperation, setRouteOperation] = useState("all");
  const [routesLoading, setRoutesLoading] = useState(true);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageDays, setUsageDays] = useState<7 | 30 | 90>(30);
  const [canReadProviderBalance, setCanReadProviderBalance] = useState(false);
  const [providerBalances, setProviderBalances] = useState<Record<string, ProviderBalance>>({});
  const [billingPending, setBillingPending] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    const payload = await readJson<{ summary: Summary }>(await fetch(`/api/projects/${projectId}/governance`, { cache: "no-store" }));
    setSummary(payload.summary);
  }, [projectId]);

  const fetchOperations = useCallback(async () => {
    setOperationsLoading(true);
    const query = new URLSearchParams({ limit: "20" });
    if (operationCursor) query.set("cursor", operationCursor);
    if (deferredOperationSearch.trim()) query.set("search", deferredOperationSearch.trim());
    if (operationKind !== "all") query.set("kind", operationKind);
    if (operationStatus !== "all") query.set("status", operationStatus);
    try {
      const page = await readJson<Page<Operation>>(await fetch(`/api/projects/${projectId}/governance/operations?${query}`, { cache: "no-store" }));
      setOperations(page.items);
      setOperationNextCursor(page.nextCursor);
    } finally {
      setOperationsLoading(false);
    }
  }, [deferredOperationSearch, operationCursor, operationKind, operationStatus, projectId]);

  const fetchRoutes = useCallback(async () => {
    setRoutesLoading(true);
    const query = new URLSearchParams({ limit: "20" });
    if (routeCursor) query.set("cursor", routeCursor);
    if (deferredRouteSearch.trim()) query.set("search", deferredRouteSearch.trim());
    if (routeOperation !== "all") query.set("operation", routeOperation);
    try {
      const page = await readJson<Page<RouteRevision>>(await fetch(`/api/projects/${projectId}/governance/routes?${query}`, { cache: "no-store" }));
      setRoutes(page.items);
      setRouteNextCursor(page.nextCursor);
    } finally {
      setRoutesLoading(false);
    }
  }, [deferredRouteSearch, projectId, routeCursor, routeOperation]);

  const fetchUsage = useCallback(async (days: 7 | 30 | 90) => {
    const payload = await readJson<{ usage: Usage; permissions: { readProviderBalance: boolean } }>(await fetch(`/api/projects/${projectId}/governance/usage?days=${days}`, { cache: "no-store" }));
    setUsage(payload.usage);
    setCanReadProviderBalance(payload.permissions.readProviderBalance);
  }, [projectId]);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchSummary(), fetchUsage(usageDays)]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "治理数据加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [fetchSummary, fetchUsage, usageDays]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  useEffect(() => { const timer = window.setTimeout(() => void fetchOperations().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "任务记录加载失败")), 0); return () => window.clearTimeout(timer); }, [fetchOperations]);
  useEffect(() => { const timer = window.setTimeout(() => void fetchRoutes().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "路由记录加载失败")), 0); return () => window.clearTimeout(timer); }, [fetchRoutes]);

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

  async function refreshProviderBalance(providerConnectionId: string) {
    setBillingPending(providerConnectionId);
    setBillingError(null);
    try {
      const payload = await readJson<{ balance: ProviderBalance }>(await fetch(`/api/projects/${projectId}/governance/provider-balance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerConnectionId }),
      }));
      setProviderBalances((current) => ({ ...current, [providerConnectionId]: payload.balance }));
    } catch (balanceError) {
      setBillingError(balanceError instanceof Error ? balanceError.message : "供应商余额读取失败");
    } finally {
      setBillingPending(null);
    }
  }

  const routedProviders = usage === null
    ? []
    : [...new Map(usage.routes.map((route) => [route.providerConnectionId, route])).values()];

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="governance" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-10 sm:px-8 lg:px-10">
        <section className="flex flex-wrap items-end justify-between gap-5 pb-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Project management</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目管理</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">这里只处理项目计划、权限、动作审批、任务运行与模型路由等管理工作。资料候选审核已归入“项目资料”。</p>
          </div>
          <button type="button" onClick={() => void Promise.all([reload(), fetchOperations(), fetchRoutes()])} disabled={loading || operationsLoading || routesLoading} className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-40">刷新</button>
        </section>

        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {message ? <div role="status" className="mb-6 rounded-2xl border border-indigo-100 bg-indigo-50 px-5 py-4 text-sm text-indigo-800">{message}</div> : null}
        <nav aria-label="项目管理功能" className="mb-8 grid gap-3 sm:grid-cols-3">
          <Link href={`/projects/${projectId}/plan`} className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700"><span className="text-sm font-semibold">项目计划</span><span className="mt-1 block text-xs text-slate-500">查看目标、建议与执行顺序</span></Link>
          <Link href={`/projects/${projectId}/actions`} className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700"><span className="text-sm font-semibold">动作与审批</span><span className="mt-1 block text-xs text-slate-500">处理外部动作及人工审批</span></Link>
          <Link href={`/projects/${projectId}/tools`} className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700"><span className="text-sm font-semibold">工具权限</span><span className="mt-1 block text-xs text-slate-500">管理项目可使用的只读工具</span></Link>
        </nav>
        {loading || summary === null ? <div className="h-44 animate-pulse rounded-3xl bg-slate-200" /> : (
          <>
            <section className="grid gap-4 md:grid-cols-3">
              <Metric label="待人工收口" value={summary.jobs.reconciliationRequired} detail="结果未知且需要人工确认的任务" tone={summary.jobs.reconciliationRequired > 0 ? "amber" : "slate"} />
              <Metric label="运行异常" value={summary.jobs.failed + summary.github.partial + summary.github.rateLimited + summary.github.unknown} detail={`失败任务 ${summary.jobs.failed} · 仓库风险 ${summary.github.partial + summary.github.rateLimited + summary.github.unknown}`} tone={summary.jobs.failed + summary.github.unknown > 0 ? "rose" : "slate"} />
              <Metric label="语义索引" value={readinessLabels[summary.index.readiness] ?? summary.index.readiness} detail={`${summary.index.activeRecordCount} 条活动记忆`} tone={summary.index.compatible ? "emerald" : "amber"} />
            </section>

            <section id="ai-usage" className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
                <SectionHeader eyebrow="AI routes & billing" title="AI 用量与计费" description="直接查看项目当前使用的模型路由、调用次数与 Token。供应商实际账单与本地调用审计分开显示。" border={false} />
                <div className="flex rounded-xl bg-slate-100 p-1" aria-label="用量统计周期">{([7, 30, 90] as const).map((days) => <button key={days} type="button" onClick={() => setUsageDays(days)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${usageDays === days ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>{days} 天</button>)}</div>
              </div>
              {usage === null ? <div className="mt-6 h-32 animate-pulse rounded-2xl bg-slate-100" /> : (
                <>
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-slate-800">当前 AI 路由</h3>
                    {usage.routes.length === 0 ? <p className="mt-3 rounded-2xl bg-slate-50 px-4 py-5 text-xs text-slate-500">当前项目尚未配置模型路由。</p> : <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{usage.routes.map((route) => (
                      <article key={`${route.operation}:${route.providerConnectionId}`} className="rounded-2xl border border-slate-200 p-4">
                        <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-800">{operationLabels[route.operation] ?? route.operation}</p><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${route.providerStatus === "verified" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{route.providerStatus === "verified" ? "已验证" : route.providerStatus}</span></div>
                        <p className="mt-3 text-sm font-semibold text-slate-700">{route.providerName}</p>
                        <p className="mt-1 break-all text-xs text-slate-500">{route.modelId}</p>
                      </article>
                    ))}</div>}
                  </div>

                  <div className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5">
                    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">供应商实际计费</h3>
                        <p className="mt-2 text-xs leading-5 text-slate-600">本页的请求数与 Token 来自应用审计；实际扣费由供应商根据当次价格、缓存命中和计费时段结算。读取余额只会使用已保存的供应商凭据查询账户余额，不会发送项目资料。</p>
                      </div>
                      <div className="space-y-3">
                        {routedProviders.length === 0 ? <p className="text-xs text-slate-500">配置模型路由后，可在这里查看对应供应商的计费入口。</p> : routedProviders.map((provider) => {
                          const balance = providerBalances[provider.providerConnectionId];
                          return (
                            <article key={provider.providerConnectionId} className="rounded-xl border border-indigo-100 bg-white p-4">
                              <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold text-slate-800">{provider.providerName}</p><p className="mt-1 text-[11px] text-slate-400">账户余额 · 非项目成本分摊</p></div>{provider.balanceAvailable && canReadProviderBalance ? <button type="button" onClick={() => void refreshProviderBalance(provider.providerConnectionId)} disabled={billingPending !== null} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{billingPending === provider.providerConnectionId ? "读取中…" : balance ? "刷新余额" : "读取账户余额"}</button> : null}</div>
                              {provider.balanceAvailable && !canReadProviderBalance ? <p className="mt-3 text-xs text-slate-500">项目 Owner 或工作区管理员可读取账户余额。</p> : null}
                              {!provider.balanceAvailable ? <p className="mt-3 text-xs text-slate-500">该供应商暂不支持应用内余额查询，请在供应商控制台核对账单。</p> : null}
                              {balance ? <div className="mt-3 space-y-2">{balance.balances.map((item) => <div key={item.currency} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs"><span className="text-slate-500">{item.currency} 可用余额</span><span className="font-semibold text-slate-800">{item.total} {item.currency}</span></div>)}<p className="text-[10px] text-slate-400">{balance.isAvailable ? "账户可正常调用" : "账户当前不可调用"} · 查询于 {formatDate(balance.fetchedAt)}</p></div> : null}
                              {provider.providerKind === "deepseek" ? <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold"><a href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer" className="text-indigo-700 underline decoration-indigo-200 underline-offset-4">查看实际用量</a><a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" target="_blank" rel="noreferrer" className="text-indigo-700 underline decoration-indigo-200 underline-offset-4">查看官方价格</a></div> : null}
                            </article>
                          );
                        })}
                        {billingError ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">{billingError}</p> : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <UsageMetric label="模型调用尝试" value={formatNumber(usage.totals.requestCount)} detail={`${formatNumber(usage.totals.recordCount)} 条审计/运行记录`} />
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

            <details id="task-runs" open className="group mt-8 scroll-mt-44 rounded-3xl border border-slate-200 bg-white shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-sm font-semibold text-slate-800 marker:hidden sm:px-8 [&::-webkit-details-marker]:hidden"><span>任务运行记录</span><span className="text-xs font-medium text-slate-400 group-open:hidden">展开记录</span><span className="hidden text-xs font-medium text-slate-400 group-open:inline">收起</span></summary>
              <div className="border-t border-slate-100 p-6 sm:p-8">
              <SectionHeader eyebrow="Recoverable operations" title="任务异常与人工收口" description="未知结果不会自动重试。只有具备对应不可变证据的任务才显示人工收口动作。" />
              <div className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_180px_180px]"><label><span className="sr-only">搜索任务记录</span><input value={operationSearch} onChange={(event) => { setOperationSearch(event.target.value); setOperationCursor(null); setOperationHistory([]); }} placeholder="搜索执行阶段或错误代码" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300" /></label><label><span className="sr-only">按任务类型筛选</span><select value={operationKind} onChange={(event) => { setOperationKind(event.target.value); setOperationCursor(null); setOperationHistory([]); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700"><option value="all">全部任务类型</option>{Object.entries(jobLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className="sr-only">按任务状态筛选</span><select value={operationStatus} onChange={(event) => { setOperationStatus(event.target.value); setOperationCursor(null); setOperationHistory([]); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700"><option value="all">全部状态</option>{["queued", "waitingConsent", "running", "succeeded", "failed", "unknown", "cancelled"].map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label></div>
              {operationsLoading ? <div className="mt-6 h-32 animate-pulse rounded-2xl bg-slate-100" /> : operations.length === 0 ? <Empty text="当前筛选条件下没有项目任务。" /> : <div className="mt-6 divide-y divide-slate-100">{operations.map((operation) => (
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
              <CursorPagination page={operationHistory.length + 1} hasPrevious={operationHistory.length > 0} hasNext={operationNextCursor !== null} disabled={operationsLoading} onPrevious={() => { const previous = operationHistory.at(-1) ?? null; setOperationHistory((current) => current.slice(0, -1)); setOperationCursor(previous); }} onNext={() => { if (!operationNextCursor) return; setOperationHistory((current) => [...current, operationCursor]); setOperationCursor(operationNextCursor); }} />
              </div>
            </details>

            <details id="route-history" open className="group mt-8 scroll-mt-44 rounded-3xl border border-slate-200 bg-white shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-sm font-semibold text-slate-800 marker:hidden sm:px-8 [&::-webkit-details-marker]:hidden"><span>模型路由变更记录</span><span className="text-xs font-medium text-slate-400 group-open:hidden">展开低频审计</span><span className="hidden text-xs font-medium text-slate-400 group-open:inline">收起</span></summary>
              <div className="border-t border-slate-100 p-6 sm:p-8">
              <SectionHeader eyebrow="Immutable audit" title="模型路由变更记录" description="这里只显示已发生的路由修订，不提供编辑或回滚动作。切换模型不会改写历史记忆。" />
              <div className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_220px]"><label><span className="sr-only">搜索模型路由变更</span><input value={routeSearch} onChange={(event) => { setRouteSearch(event.target.value); setRouteCursor(null); setRouteHistory([]); }} placeholder="搜索供应商或模型 ID" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300" /></label><label><span className="sr-only">按 AI 能力筛选</span><select value={routeOperation} onChange={(event) => { setRouteOperation(event.target.value); setRouteCursor(null); setRouteHistory([]); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700"><option value="all">全部 AI 能力</option>{Object.entries(operationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
              {routesLoading ? <div className="mt-6 h-32 animate-pulse rounded-2xl bg-slate-100" /> : routes.length === 0 ? <Empty text="当前筛选条件下没有模型路由变更记录。" /> : <div className="mt-6 space-y-3">{routes.map((route) => (
                <article key={route.id} className="rounded-2xl border border-slate-200 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{route.operation}</span>{route.indexInvalidated ? <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">索引已失效</span> : null}</div><span className="text-xs text-slate-400">{formatDate(route.createdAt)} · {route.actor}</span></div>
                  <div className="mt-4 grid gap-3 text-xs sm:grid-cols-[1fr_auto_1fr]"><RouteBox label="原路由" route={route.previous} /><span className="hidden self-center text-slate-300 sm:block">→</span><RouteBox label="新路由" route={route.current} /></div>
                  {route.indexInvalidated ? <p className="mt-3 text-xs text-amber-800">现有索引未被改写；请前往 <Link href={`/projects/${projectId}/memory`} className="font-semibold underline">智能记忆</Link> 显式重建。</p> : null}
                </article>
              ))}</div>}
              <CursorPagination page={routeHistory.length + 1} hasPrevious={routeHistory.length > 0} hasNext={routeNextCursor !== null} disabled={routesLoading} onPrevious={() => { const previous = routeHistory.at(-1) ?? null; setRouteHistory((current) => current.slice(0, -1)); setRouteCursor(previous); }} onNext={() => { if (!routeNextCursor) return; setRouteHistory((current) => [...current, routeCursor]); setRouteCursor(routeNextCursor); }} />
              </div>
            </details>
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

function RouteBox({ label, route }: { label: string; route: RouteRevision["previous"] | RouteRevision["current"] }) {
  if (route === null) return <div className="rounded-xl bg-slate-50 p-4"><p className="font-semibold text-slate-500">{label}</p><p className="mt-2 text-slate-400">首次配置</p></div>;
  return <div className="rounded-xl bg-slate-50 p-4"><p className="font-semibold text-slate-500">{label}</p><p className="mt-2 font-semibold text-slate-700">{route.providerName ?? route.providerKind ?? "已移除供应商"}</p><p className="mt-1 break-all text-slate-500">{route.modelId}{route.embeddingDimensions ? ` · ${route.embeddingDimensions} 维` : ""}</p></div>;
}
