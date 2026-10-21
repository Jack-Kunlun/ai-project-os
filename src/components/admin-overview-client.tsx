"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useAppearance } from "@/components/appearance-provider";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PlatformDefaultAiOperation } from "@/lib/platform-default-ai-routes";
import type { SystemOverview, SystemOverviewFailureAggregate, SystemOverviewRoute } from "@/lib/system-overview";
import { AdminPageHeader } from "@/components/admin-page-header";

const operationLabels: Record<PlatformDefaultAiOperation, string> = {
  embedding: "向量化",
  visionExtract: "图片识别",
  autoExtract: "自动抽取",
  sourceSummary: "资料摘要",
  projectAnalysis: "项目分析",
  generateWithContext: "带上下文生成",
};

const routeCodeLabels: Record<SystemOverviewRoute["code"], string> = {
  missing: "未配置",
  "provider-invalid": "供应商归属无效",
  "provider-not-verified": "供应商待验证",
  "provider-disabled": "供应商已停用",
  "configuration-changed": "配置已变化",
  "capability-mismatch": "能力不匹配",
  "not-validated": "路由待验证",
  ready: "控制面已就绪",
  not_obtained: "未取得证据",
};

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "管理总览加载失败";
  } catch {
    return "管理总览加载失败";
  }
}

function workerLabel(status: SystemOverview["service"]["worker"]["status"]): string {
  return { up: "运行中", starting: "启动中", degraded: "降级", stopping: "停止中", stale: "心跳过期", missing: "未发现" }[status];
}

function formatDate(value: string | null, language: "zh-CN" | "en", t: (text: string) => string): string {
  if (value === null) return t("未取得");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("未取得") : new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function valueLabel(value: number | null, language: "zh-CN" | "en"): string {
  return value === null ? "—" : value.toLocaleString(language);
}

function statusTone(status: "ready" | "attention" | "unknown" | "restricted"): string {
  return {
    ready: "bg-emerald-50 text-emerald-700",
    attention: "bg-amber-50 text-amber-800",
    unknown: "bg-slate-100 text-slate-600",
    restricted: "bg-slate-100 text-slate-600",
  }[status];
}

function routeStatusTone(route: SystemOverviewRoute): string {
  return route.controlPlane === "ready" ? "bg-emerald-50 text-emerald-700" : route.controlPlane === "not_obtained" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800";
}

export type AdminPendingActionState = "pending" | "clear" | "unknown";

export type AdminPendingActionProjection = Readonly<{
  key: "failures" | "mcp" | "models" | "routes";
  title: string;
  value: string;
  state: AdminPendingActionState;
  detail: string;
  href: string;
}>;

export type AdminPendingActionData = Readonly<{
  failureTotal: number | null;
  pendingMcp: number | null;
  verifiedPlatformModels: number;
  defaultRoutes: Readonly<{ ready: number | null; total: number }>;
}>;

const pendingActionDefinitions = [
  { key: "failures" as const, title: "失败事件", href: "/admin/operations/failures" },
  { key: "mcp" as const, title: "待审核 MCP", href: "/admin/connectors/mcp" },
  { key: "models" as const, title: "可用模型", href: "/admin/models" },
  { key: "routes" as const, title: "能力配置", href: "/admin/models" },
] as const;

export function projectAdminPendingActions(data: AdminPendingActionData | null, loading: boolean, language: "zh-CN" | "en" = "zh-CN"): readonly AdminPendingActionProjection[] {
  if (loading) {
    return pendingActionDefinitions.map((definition) => ({
      ...definition,
      value: "读取中…",
      state: "unknown" as const,
      detail: "正在读取本次测量证据。",
    }));
  }
  if (data === null) {
    return pendingActionDefinitions.map((definition) => ({
      ...definition,
      value: "未取得",
      state: "unknown" as const,
      detail: "本次测量未取得证据。",
    }));
  }
  const failure = data.failureTotal === null
    ? { value: "未取得", state: "unknown" as const, detail: "尚未取得失败聚合证据。" }
    : data.failureTotal > 0
      ? { value: data.failureTotal.toLocaleString(language), state: "pending" as const, detail: "有平台异常需要继续核对。" }
      : { value: "0", state: "clear" as const, detail: "本次测量没有平台失败。" };
  const mcp = data.pendingMcp === null
    ? { value: "未取得", state: "unknown" as const, detail: "尚未取得待认证数量。" }
    : data.pendingMcp > 0
      ? { value: data.pendingMcp.toLocaleString(language), state: "pending" as const, detail: "有工具等待管理员认证。" }
      : { value: "0", state: "clear" as const, detail: "本次测量没有待认证工具。" };
  const models = data.verifiedPlatformModels === 0
    ? { value: "0", state: "pending" as const, detail: "尚未取得可用的平台模型。" }
    : { value: data.verifiedPlatformModels.toLocaleString(language), state: "clear" as const, detail: "已有可用的平台模型。" };
  const routes = data.defaultRoutes.ready === null
    ? { value: "未取得", state: "unknown" as const, detail: "尚未取得能力路由就绪证据。" }
    : data.defaultRoutes.ready < data.defaultRoutes.total
      ? { value: `${data.defaultRoutes.ready}/${data.defaultRoutes.total}`, state: "pending" as const, detail: "仍有能力路由未就绪。" }
      : { value: `${data.defaultRoutes.ready}/${data.defaultRoutes.total}`, state: "clear" as const, detail: "所有能力路由控制面已就绪。" };
  return [
    { ...pendingActionDefinitions[0], ...failure },
    { ...pendingActionDefinitions[1], ...mcp },
    { ...pendingActionDefinitions[2], ...models },
    { ...pendingActionDefinitions[3], ...routes },
  ];
}

export function AdminOverviewClient() {
  const { language, t } = useAppearance();
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/overview", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      setOverview(await response.json() as SystemOverview);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "管理总览加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const worker = overview?.service.worker;
  const routeReady = overview?.defaultRoutes.ready;
  const failureTotal = overview === null ? null : overview.failures.total;
  const pendingMcp = overview === null ? null : overview.mcp.pendingAttestations;
  const pendingActions = projectAdminPendingActions(overview === null ? null : {
    failureTotal: overview.failures.total,
    pendingMcp: overview.mcp.pendingAttestations,
    verifiedPlatformModels: overview.counts.verifiedPlatformModels,
    defaultRoutes: overview.defaultRoutes,
  }, loading, language);

  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="平台总览" meta={overview ? <>{t("测量于")} {formatDate(overview.service.measuredAt, language, t)} · {overview.service.version}</> : loading ? t("正在读取最新状态…") : t("未取得最新状态")} />

    {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}

    <section className="mt-5" aria-labelledby="admin-service-health-title">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"><UiText text={"服务健康"} /></p><h2 id="admin-service-health-title" className="mt-1 text-lg font-semibold text-slate-950"><UiText text={"服务健康"} /></h2></div>
        <span className="text-xs text-slate-500"><UiText text={"状态仅依据本次安全读取"} /></span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusCard label="应用服务" value={loading ? t("读取中…") : overview ? t("正常") : t("未取得")} detail={loading ? t("等待安全读取") : overview ? `${t("版本")} ${overview.service.version}` : t("本次测量未取得应用状态。")} tone="emerald" />
        <StatusCard label="数据库" value={loading ? t("读取中…") : overview?.service.database === "up" ? t("可用") : t("未取得")} detail={loading ? t("等待安全读取") : overview?.service.database === "up" ? t("只读健康检查通过") : t("本次测量未取得数据库健康证据。")} tone="cyan" />
        <StatusCard label="Worker" value={loading ? t("读取中…") : worker ? t(workerLabel(worker.status)) : t("未取得")} detail={loading ? t("等待安全读取") : worker ? workerDetail(worker, t) : t("本次测量未取得 Worker 状态。")} tone="violet" />
      </div>
    </section>

    <section className="mt-5 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="admin-pending-actions-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"><UiText text={"操作队列"} /></p>
          <h2 id="admin-pending-actions-title" className="mt-1 text-lg font-semibold text-slate-950"><UiText text={"待处理事项"} /></h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600"><UiText text={"只根据本次已取得的安全聚合判断。数量为 0 表示当前测量没有待办；“未取得”表示证据尚未返回。"} /></p>
        </div>
      </div>
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">{pendingActions.map((action) => <ActionCard key={action.key} action={action} t={t} />)}</div>
    </section>

    <section className="mt-5 grid items-stretch gap-3 lg:grid-cols-[0.8fr_1.2fr]" aria-label={t("平台规模与额度")}>
      <div className="flex h-full flex-col rounded-2xl border border-slate-200/80 bg-white p-5"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"><UiText text={"安全计数"} /></p><h2 className="mt-1 text-lg font-semibold"><UiText text={"平台规模"} /></h2><div className="mt-auto grid grid-cols-3 gap-2 pt-4"><Count label="用户" value={overview?.counts.users} language={language} /><Count label="有效会员" value={overview?.counts.activeMemberships} language={language} /><Count label="已验证平台连接" value={overview?.counts.verifiedPlatformModels} language={language} /></div></div>
      <div className="flex h-full flex-col rounded-2xl border border-slate-200/80 bg-white p-5"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"><UiText text={"平台额度账本"} /></p><h2 className="mt-1 text-lg font-semibold"><UiText text={"平台额度总览"} /></h2><p className="mt-1 text-xs leading-5 text-slate-600"><UiText text={"只读聚合：累计发放、当前可用、预留 / 待核对占用和已确认消耗。"} /></p><div className="mt-auto grid grid-cols-2 gap-2 pt-4 sm:grid-cols-4"><Count label="累计发放" value={overview?.tokens.issuedTokens} language={language} /><Count label="当前可用" value={overview?.tokens.availableTokens} language={language} /><Count label="预留 / 待核对占用" value={overview?.tokens.reservedTokens} language={language} /><Count label="已确认消耗" value={overview?.tokens.consumedTokens} language={language} /></div></div>
    </section>

    <section className="mt-5" aria-labelledby="admin-kpi-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><UiText text={"今日 · Asia/Shanghai"} /></p><h2 id="admin-kpi-title" className="mt-1 text-xl font-semibold text-slate-950"><UiText text={"核心指标"} /></h2></div>
        <span className="text-xs text-slate-400"><UiText text={"不含个人 BYOK · 未接入支付金额"} /></span>
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
        <KpiCard label="今日新增用户" value={analyticsValue(overview?.analytics.today.newUsers, loading, language, t)} detail="普通用户创建数" />
        <KpiCard label="今日托管 Token" value={analyticsValue(overview?.analytics.today.platformTokens, loading, language, t)} detail="仅 usageKnown=true" />
        <KpiCard label="调用待核对" value={analyticsValue(overview?.analytics.today.unknownCalls, loading, language, t)} detail="仅终态待核对" />
        <KpiCard label="今日额度消耗" value={analyticsValue(overview?.analytics.today.settledQuota, loading, language, t)} detail="已结算平台额度" />
        <KpiCard label="有效会员" value={analyticsValue(overview?.analytics.today.activeMemberships, loading, language, t)} detail="当前有效资格" />
      </div>
    </section>

    <AnalyticsTrendSection overview={overview} loading={loading} language={language} t={t} />

    <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7" aria-labelledby="admin-readiness-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><UiText text={"首次设置清单"} /></p>
          <h2 id="admin-readiness-title" className="mt-2 text-xl font-semibold text-slate-950"><UiText text={"平台首次就绪清单"} /></h2>
          <p className="mt-2 text-xs leading-5 text-slate-500"><UiText text={"清单只反映已取得的安全状态；“已就绪”不代表外部模型调用已经现场验证。"} /></p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">{loading ? t("读取中…") : overview ? `${overview.setupChecklist.filter((item) => item.status === "ready").length}/${overview.setupChecklist.length} ${t("项完成")}` : t("未取得")}</span>
      </div>
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        {(overview?.setupChecklist ?? []).map((item) => <article key={item.key} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">{t(item.label)}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${statusTone(item.status)}`}>{t(checklistStatusLabel(item.status))}</span></div><p className="mt-2 text-xs leading-5 text-slate-500">{t(item.detail)}</p></article>)}
        {!overview ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500 sm:col-span-2 lg:col-span-3">{loading ? t("正在读取就绪证据…") : t("未取得就绪证据。")}</div> : null}
      </div>
    </section>

    <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-6 shadow-sm sm:p-7" aria-labelledby="default-route-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700"><UiText text={"平台默认路由"} /></p>
          <h2 id="default-route-title" className="mt-2 text-xl font-semibold text-slate-950"><UiText text={"默认模型路由"} /></h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-600"><UiText text={"控制面状态来自 active 路由、平台供应商归属、验证版本和能力匹配检查。当前数据没有真实调用凭证，因此每项都单独标记为“真实调用证据未取得”。"} /></p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${overview?.defaultRoutes.controlPlane === "ready" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{loading ? t("读取中…") : routeReady === null || routeReady === undefined || overview === null ? t("未取得路由证据") : `${routeReady}/${overview.defaultRoutes.total} ${t("项控制面就绪")}`}</span>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview ? Object.values(overview.defaultRoutes.operations).map((route) => <RouteCard key={route.operation} route={route} />) : <div className="rounded-2xl border border-dashed border-indigo-200 bg-white/70 p-5 text-sm text-slate-500 sm:col-span-2 lg:col-span-3">{loading ? t("正在读取默认路由状态…") : t("未取得默认路由证据。")}</div>}
      </div>
    </section>

    <section className="mt-6 grid gap-6 lg:grid-cols-3" aria-label={t("安全与恢复状态")}>
      <EvidenceCard title="MCP 认证队列" eyebrow="连接安全" value={loading ? t("读取中…") : overview ? valueLabel(pendingMcp, language) : t("未取得")} detail={loading ? t("等待安全读取") : pendingMcp === null || pendingMcp === undefined ? t("未取得待认证数量；不会暴露个人连接或工具正文。") : t("符合安全条件但尚未取得有效管理员认证的只读工具数量。")} tone={pendingMcp === null || pendingMcp === undefined ? "unknown" : pendingMcp > 0 ? "attention" : "ready"} />
      <EvidenceCard title="调度/控制面失败聚合" eyebrow="安全失败" value={loading ? t("读取中…") : overview && failureTotal !== null ? valueLabel(failureTotal, language) : t("未取得")} detail={loading ? t("等待安全读取") : overview ? failureDetail(overview, language, t) : t("本次测量未取得失败聚合证据。")} tone={failureTotal === null || failureTotal === undefined ? "unknown" : failureTotal > 0 ? "attention" : "ready"} href="/admin/operations/failures" linkLabel="打开失败收件箱" />
      <BackupCard backup={overview?.backup} loading={loading} />
    </section>

  </div>;
}

function workerDetail(worker: SystemOverview["service"]["worker"], t: (text: string) => string): string {
  const heartbeat = worker.heartbeatAgeMs === null ? t("暂无心跳") : `${t("心跳")} ${Math.round(worker.heartbeatAgeMs / 1000).toLocaleString()} ${t("秒前")}`;
  return `${heartbeat} · ${t("Worker 循环异常")} ${worker.consecutiveFailures.toLocaleString()} ${t("次")}`;
}

function analyticsValue(value: number | null | undefined, loading: boolean, language: "zh-CN" | "en", t: (text: string) => string): string {
  return value === undefined ? loading ? t("读取中…") : t("未取得") : value === null ? t("未取得") : value.toLocaleString(language);
}

function KpiCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  const t = useAppearance().t;
  return <article className="min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm"><h3 className="truncate text-xs font-semibold text-slate-500">{t(label)}</h3><p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">{value}</p><p className="mt-2 truncate text-xs text-slate-400">{t(detail)}</p></article>;
}

function AnalyticsTrendSection({ overview, loading, language, t }: { overview: SystemOverview | null; loading: boolean; language: "zh-CN" | "en"; t: (text: string) => string }) {
  const trend = overview?.analytics.trends.days7 ?? [];
  return <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="admin-trend-title">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><UiText text={"近 7 天趋势"} /></p><h2 id="admin-trend-title" className="mt-1 text-xl font-semibold text-slate-950"><UiText text={"运营趋势"} /></h2></div><span className="text-xs text-slate-400"><UiText text={"每日零值保留，读取失败显示“未取得”"} /></span></div>
    <div role="region" aria-label={t("运营趋势明细")} tabIndex={0} className="mt-4 overflow-x-auto"><table className="min-w-[600px] w-full border-collapse text-left text-xs"><thead><tr className="border-b border-slate-100 text-slate-400"><th className="whitespace-nowrap px-3 py-2 font-semibold"><UiText text={"日期"} /></th><th className="whitespace-nowrap px-3 py-2 font-semibold"><UiText text={"新增用户"} /></th><th className="whitespace-nowrap px-3 py-2 font-semibold"><UiText text={"托管 Token"} /></th><th className="whitespace-nowrap px-3 py-2 font-semibold"><UiText text={"待核对调用"} /></th><th className="whitespace-nowrap px-3 py-2 font-semibold"><UiText text={"额度消耗"} /></th></tr></thead><tbody>{trend.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">{loading ? t("正在读取趋势…") : t("未取得趋势证据。")}</td></tr> : trend.map((point) => <tr key={point.date} className="border-b border-slate-50 last:border-0"><th className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-700">{new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${point.date}T00:00:00Z`))}</th><td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{analyticsValue(point.newUsers, loading, language, t)}</td><td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{analyticsValue(point.platformTokens, loading, language, t)}</td><td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{analyticsValue(point.unknownCalls, loading, language, t)}</td><td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{analyticsValue(point.settledQuota, loading, language, t)}</td></tr>)}</tbody></table></div>
  </section>;
}

function checklistStatusLabel(status: "ready" | "attention" | "unknown" | "restricted"): string {
  return { ready: "已就绪", attention: "需处理", unknown: "未知", restricted: "受限" }[status];
}

function RouteCard({ route }: { route: SystemOverviewRoute }) {
  const t = useAppearance().t;
  return <article className="flex h-full flex-col rounded-2xl border border-white/80 bg-white p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-900">{t(operationLabels[route.operation])}</h3><p className="mt-1 text-[12px] text-slate-500">{route.routeVersion === null ? t("暂无 active 版本") : `${t("控制面版本")} v${route.routeVersion}`}</p></div><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${routeStatusTone(route)}`}>{t(routeCodeLabels[route.code])}</span></div><p className="mt-auto pt-3 text-xs leading-5 text-slate-500"><UiText text={"真实模型调用："} /><span className="font-semibold text-slate-700"><UiText text={"未取得现场证据"} /></span></p></article>;
}

function failureDetail(overview: SystemOverview, language: "zh-CN" | "en", t: (text: string) => string): string {
  const parts = [
    failureSummary("平台调度/控制面失败", overview.failures.providerCalls, t),
    failureSummary("MCP 调度/控制面失败", overview.failures.mcpCalls, t),
    failureSummary("后台任务失败", overview.failures.backgroundJobs, t),
    failureSummary("自动化失败", overview.failures.automationRuns, t),
    failureSummary("受控动作失败", overview.failures.controlledActions, t),
  ];
  return `${t("近")} ${overview.failures.window.days} ${t("天")}（${formatDate(overview.failures.window.from, language, t)} ${t("至")} ${formatDate(overview.failures.window.to, language, t)}）：${parts.join("；")}。${t("包括出站前拒绝，不表示已经出站；仅展示安全错误码聚合。")}`;
}

function failureSummary(label: string, aggregate: SystemOverviewFailureAggregate, t: (text: string) => string): string {
  return aggregate.total === null ? `${t(label)}${t("未取得")}` : `${t(label)} ${aggregate.total.toLocaleString()} ${t("次")}`;
}

function ActionCard({ action, t }: { action: AdminPendingActionProjection; t: (text: string) => string }) {
  const styles = {
    pending: "bg-amber-100 text-amber-900",
    clear: "bg-emerald-100 text-emerald-800",
    unknown: "bg-slate-100 text-slate-600",
  } as const;
  const labels = { pending: "待处理", clear: "无待办", unknown: "未取得" } as const;
  return <article className="min-w-0 rounded-2xl border border-white/80 bg-white p-4 shadow-sm"><div className="flex min-w-0 items-center justify-between gap-3"><h3 className="min-w-0 truncate whitespace-nowrap text-sm font-semibold text-slate-900">{t(action.title)}</h3><span className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold ${styles[action.state]}`}>{t(labels[action.state])}</span></div><p className="mt-4 text-2xl font-semibold text-slate-950">{action.value}</p><p className="mt-2 min-h-10 text-xs leading-5 text-slate-500">{t(action.detail)}</p><Link href={action.href} className="mt-3 inline-flex whitespace-nowrap text-xs font-semibold text-indigo-700 hover:text-indigo-900"><UiText text={"查看运营入口 →"} /></Link></article>;
}

function backupStatusLabel(value: string, t: (text: string) => string): string {
  const labels: Record<string, string> = { ready: "已就绪", not_configured: "未配置", invalid: "无效", not_obtained: "未取得", read: "已读取", restricted: "受限", error: "读取失败", available: "可用", none: "无记录", running: "执行中", succeeded: "成功", failed: "失败", skipped: "已跳过", fresh: "新鲜", stale: "陈旧", unknown: "未知", verified: "已验证", mismatch: "不匹配", matched: "匹配" };
  return t(labels[value] ?? value);
}

function BackupCard({ backup, loading }: { backup?: SystemOverview["backup"]; loading: boolean }) {
  const { language, t } = useAppearance();
  if (loading) return <EvidenceCard title="备份与恢复证据" eyebrow="恢复" value="读取中…" detail="等待安全读取" tone="unknown" />;
  if (backup === undefined) return <EvidenceCard title="备份与恢复证据" eyebrow="恢复" value="未取得" detail="本次测量未取得备份与恢复证据。" tone="unknown" />;
  if (backup.access === "restricted") return <EvidenceCard title="备份与恢复证据" eyebrow="恢复" value="受限" detail="仅初始超级管理员可读取备份任务详情；当前未取得状态新鲜度和恢复演练证据。" tone="restricted" />;
  if (backup.access === "not_obtained") return <EvidenceCard title="备份与恢复证据" eyebrow="恢复" value="未取得" detail={`${t("权限检查未完成；状态源")} ${backupStatusLabel(backup.sourceStatus, t)}，${t("任务记录、新鲜度和恢复演练均未取得。")}`} tone="unknown" />;
  const recordState = backup.latestValidRecord.state ? backupStatusLabel(backup.latestValidRecord.state, t) : t("未取得");
  const value = backup.snapshotRead === "error" ? t("读取失败") : backup.latestValidRecord.status === "none" ? t("无记录") : recordState;
  const completeEvidence = backup.snapshotRead === "read"
    && backup.latestValidRecord.status === "available"
    && backup.latestValidRecord.state === "succeeded"
    && backup.freshness.status === "fresh"
    && backup.recoveryDrill.status === "verified"
    && backup.recoveryDrill.environment === "production"
    && backup.recoveryDrill.scope === "isolated-host"
    && backup.recoveryDrill.sourceArtifactKind === "production-backup"
    && backup.recoveryDrill.freshness === "fresh"
    && backup.recoveryDrill.matchingBackup === "matched";
  const tone = completeEvidence ? "ready" : backup.snapshotRead === "error" ? "attention" : backup.latestValidRecord.status === "none" || backup.freshness.status === "unknown" ? "unknown" : "attention";
  const drill = backup.recoveryDrill;
  const drillDetail = drill.status === "verified"
    ? `${t("恢复演练已验证")}（${t(drill.environment === "local" ? "本机隔离，不作为生产就绪" : "生产异地主机")}）· ${t("新鲜度")} ${backupStatusLabel(drill.freshness, t)} · ${t("生产备份绑定")} ${backupStatusLabel(drill.matchingBackup, t)} · ${t("完成于")} ${formatDate(drill.completedAt, language, t)} · ${t("摘要")} ${drill.validationSha256?.slice(0, 12) ?? t("未取得")}…`
    : drill.status === "failed" ? `${t("恢复演练失败；新鲜度")} ${backupStatusLabel(drill.freshness, t)}，${t("不把备份成功显示为可恢复。")}` : `${t("恢复演练")} ${backupStatusLabel(drill.status, t)}；${t("不把备份成功显示为可恢复。")}`;
  return <EvidenceCard title="备份与恢复证据" eyebrow="恢复" value={completeEvidence ? "已就绪" : value} detail={`${t("备份：状态源")} ${backupStatusLabel(backup.sourceStatus, t)} · ${t("任务读取")} ${backupStatusLabel(backup.snapshotRead, t)} · ${t("最新记录")} ${recordState} · ${t("新鲜度")} ${backupStatusLabel(backup.freshness.status, t)}（${t("阈值")} ${Math.round(backup.freshness.thresholdMs / (60 * 60 * 1_000))} ${t("小时")}）。${drillDetail}`} tone={tone} href={drill.runbookHref} linkLabel="打开恢复演练 Runbook" />;
}

function EvidenceCard({ title, eyebrow, value, detail, tone, href, linkLabel }: { title: string; eyebrow: string; value: string; detail: string; tone: "ready" | "attention" | "unknown" | "restricted"; href?: string; linkLabel?: string }) {
  const t = useAppearance().t;
  return <article className="flex h-full flex-col rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{t(eyebrow)}</p><h2 className="mt-2 text-lg font-semibold text-slate-950">{t(title)}</h2><p className={`mt-4 inline-flex self-start rounded-full px-3 py-1.5 text-sm font-semibold ${statusTone(tone)}`}>{t(value)}</p><p className="mt-3 flex-1 text-xs leading-5 text-slate-500">{t(detail)}</p>{href && linkLabel ? <Link href={href} className="mt-4 inline-flex self-start rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">{t(linkLabel)}</Link> : null}</article>;
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "emerald" | "cyan" | "violet" }) {
  const t = useAppearance().t;
  const styles = { emerald: "bg-emerald-50 text-emerald-700", cyan: "bg-cyan-50 text-cyan-700", violet: "bg-violet-50 text-violet-700" } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-500">{t(label)}</p><p className={`mt-3 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${styles[tone]}`}>{t(value)}</p><p className="mt-3 text-xs leading-5 text-slate-500">{t(detail)}</p></article>;
}

function Count({ label, value, language }: { label: string; value?: number | null; language: "zh-CN" | "en" }) {
  const t = useAppearance().t;
  return <div className="rounded-2xl bg-slate-50 px-3 py-4"><p className="text-2xl font-semibold text-slate-900">{value === undefined || value === null ? "—" : value.toLocaleString(language)}</p><p className="mt-1 text-[12px] text-slate-500">{t(label)}</p></div>;
}
