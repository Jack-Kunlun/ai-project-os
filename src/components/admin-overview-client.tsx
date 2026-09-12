"use client";

import { useEffect, useState } from "react";
import type { PlatformDefaultAiOperation } from "@/lib/platform-default-ai-routes";
import type { SystemOverview, SystemOverviewFailureAggregate, SystemOverviewRoute } from "@/lib/system-overview";

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

function formatDate(value: string | null): string {
  if (value === null) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未取得" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function valueLabel(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("zh-CN");
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

export function AdminOverviewClient() {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/overview", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      setOverview(await response.json() as SystemOverview);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "管理总览加载失败");
    });
    return () => controller.abort();
  }, []);

  const worker = overview?.service.worker;
  const routeReady = overview?.defaultRoutes.ready;
  const failureTotal = overview?.failures.total;
  const pendingMcp = overview?.mcp.pendingAttestations;

  return <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-8 lg:px-10">
    <section className="rounded-[2rem] bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">System overview</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">管理员总览</h1>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里把平台托管配置、控制面状态和真实运行证据分开显示。只读聚合不会包含邮箱、凭据、个人账本、连接 Token 或外部调用正文。</p>
      {overview ? <p className="mt-4 text-xs text-slate-300">测量于 {formatDate(overview.service.measuredAt)} · 应用版本 {overview.service.version}</p> : null}
    </section>

    {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}

    <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="应用服务状态">
      <StatusCard label="应用服务" value={overview ? "正常" : "读取中…"} detail={overview ? `版本 ${overview.service.version}` : "等待安全读取"} tone="emerald" />
      <StatusCard label="数据库" value={overview?.service.database === "up" ? "可用" : "读取中…"} detail="只读健康检查" tone="cyan" />
      <StatusCard label="Worker" value={worker ? workerLabel(worker.status) : "读取中…"} detail={worker ? workerDetail(worker) : "等待安全读取"} tone="violet" />
    </section>

    <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7" aria-labelledby="admin-readiness-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">First setup checklist</p>
          <h2 id="admin-readiness-title" className="mt-2 text-xl font-semibold text-slate-950">平台首次就绪清单</h2>
          <p className="mt-2 text-xs leading-5 text-slate-500">清单只反映已取得的安全状态；“已就绪”不代表外部模型调用已经现场验证。</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">{overview ? `${overview.setupChecklist.filter((item) => item.status === "ready").length}/${overview.setupChecklist.length} 项完成` : "读取中…"}</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(overview?.setupChecklist ?? []).map((item) => <article key={item.key} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">{item.label}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${statusTone(item.status)}`}>{checklistStatusLabel(item.status)}</span></div><p className="mt-2 text-xs leading-5 text-slate-500">{item.detail}</p></article>)}
        {!overview ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500 sm:col-span-2 lg:col-span-3">正在读取就绪证据…</div> : null}
      </div>
    </section>

    <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-6 shadow-sm sm:p-7" aria-labelledby="default-route-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Platform default routes</p>
          <h2 id="default-route-title" className="mt-2 text-xl font-semibold text-slate-950">默认模型路由</h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-600">控制面状态来自 active 路由、平台供应商归属、验证版本和能力匹配检查。当前数据没有真实调用凭证，因此每项都单独标记为“真实调用证据未取得”。</p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${overview?.defaultRoutes.controlPlane === "ready" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{routeReady === null || routeReady === undefined || overview === null ? "未取得路由证据" : `${routeReady}/${overview.defaultRoutes.total} 项控制面就绪`}</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview ? Object.values(overview.defaultRoutes.operations).map((route) => <RouteCard key={route.operation} route={route} />) : <div className="rounded-2xl border border-dashed border-indigo-200 bg-white/70 p-5 text-sm text-slate-500 sm:col-span-2 lg:col-span-3">正在读取默认路由状态…</div>}
      </div>
    </section>

    <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Safe counts</p><h2 className="mt-2 text-xl font-semibold">平台规模</h2><div className="mt-5 grid grid-cols-3 gap-3"><Count label="用户" value={overview?.counts.users} /><Count label="有效会员" value={overview?.counts.activeMemberships} /><Count label="已验证平台连接" value={overview?.counts.verifiedPlatformModels} /></div></div>
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Platform credit ledger</p><h2 className="mt-2 text-xl font-semibold">平台额度总览</h2><p className="mt-2 text-xs leading-5 text-slate-500">只读聚合：累计发放、当前可用、预留 / 待核对占用和已确认消耗。</p><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><Count label="累计发放" value={overview?.tokens.issuedTokens} /><Count label="当前可用" value={overview?.tokens.availableTokens} /><Count label="预留 / 待核对占用" value={overview?.tokens.reservedTokens} /><Count label="已确认消耗" value={overview?.tokens.consumedTokens} /></div></div>
    </section>

    <section className="mt-6 grid gap-6 lg:grid-cols-3" aria-label="安全与恢复状态">
      <EvidenceCard title="MCP 认证队列" eyebrow="Connection safety" value={overview ? valueLabel(pendingMcp ?? null) : "读取中…"} detail={pendingMcp === null || pendingMcp === undefined ? "未取得待认证数量；不会暴露个人连接或工具正文。" : "符合安全条件但尚未取得有效管理员认证的只读工具数量。"} tone={pendingMcp === null || pendingMcp === undefined ? "unknown" : pendingMcp > 0 ? "attention" : "ready"} />
      <EvidenceCard title="调度/控制面失败聚合" eyebrow="Safe failures" value={failureTotal === null || failureTotal === undefined ? "—" : valueLabel(failureTotal)} detail={overview ? failureDetail(overview) : "不会显示调用正文，只读取安全错误码聚合。"} tone={failureTotal === null || failureTotal === undefined ? "unknown" : failureTotal > 0 ? "attention" : "ready"} />
      <BackupCard backup={overview?.backup} />
    </section>

    <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Ownership boundary</p><h2 className="mt-2 text-xl font-semibold">管理员能看什么</h2><div className="mt-4 grid gap-3 text-sm leading-6 text-slate-600 sm:grid-cols-3"><p className="rounded-2xl bg-slate-50 px-4 py-4"><strong className="text-slate-900">平台托管模型</strong><br />管理员维护平台连接和默认路由；普通用户按平台额度使用。</p><p className="rounded-2xl bg-slate-50 px-4 py-4"><strong className="text-slate-900">个人 Git / MCP</strong><br />连接归创建它的用户。管理员只处理安全策略、认证和聚合状态，不读取个人凭据。</p><p className="rounded-2xl bg-slate-50 px-4 py-4"><strong className="text-slate-900">备份与恢复</strong><br />任务结果、状态读取新鲜度和恢复演练证据分别展示；缺失证据保持“未取得”。</p></div></section>
  </div>;
}

function workerDetail(worker: SystemOverview["service"]["worker"]): string {
  const heartbeat = worker.heartbeatAgeMs === null ? "暂无心跳" : `心跳 ${Math.round(worker.heartbeatAgeMs / 1000)} 秒前`;
  return `${heartbeat} · Worker 循环异常 ${worker.consecutiveFailures} 次`;
}

function checklistStatusLabel(status: "ready" | "attention" | "unknown" | "restricted"): string {
  return { ready: "已就绪", attention: "需处理", unknown: "未知", restricted: "受限" }[status];
}

function RouteCard({ route }: { route: SystemOverviewRoute }) {
  return <article className="rounded-2xl border border-white/80 bg-white p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-900">{operationLabels[route.operation]}</h3><p className="mt-1 text-[12px] text-slate-500">{route.routeVersion === null ? "暂无 active 版本" : `控制面版本 v${route.routeVersion}`}</p></div><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${routeStatusTone(route)}`}>{routeCodeLabels[route.code]}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">真实模型调用：<span className="font-semibold text-slate-700">未取得现场证据</span></p></article>;
}

function failureDetail(overview: SystemOverview): string {
  const parts = [
    failureSummary("平台调度/控制面失败", overview.failures.providerCalls),
    failureSummary("MCP 调度/控制面失败", overview.failures.mcpCalls),
    failureSummary("后台任务失败", overview.failures.backgroundJobs),
    failureSummary("自动化失败", overview.failures.automationRuns),
    failureSummary("受控动作失败", overview.failures.controlledActions),
  ];
  return `近 ${overview.failures.window.days} 天（${formatDate(overview.failures.window.from)} 至 ${formatDate(overview.failures.window.to)}）：${parts.join("；")}。包括出站前拒绝，不表示已经出站；仅展示安全错误码聚合。`;
}

function failureSummary(label: string, aggregate: SystemOverviewFailureAggregate): string {
  return aggregate.total === null ? `${label}未取得` : `${label} ${aggregate.total} 次`;
}

function BackupCard({ backup }: { backup?: SystemOverview["backup"] }) {
  if (backup === undefined) return <EvidenceCard title="备份证据" eyebrow="Recovery" value="读取中…" detail="等待安全读取" tone="unknown" />;
  if (backup.access === "restricted") return <EvidenceCard title="备份证据" eyebrow="Recovery" value="受限" detail="仅初始超级管理员可读取备份任务详情；当前未取得状态新鲜度和恢复演练证据。" tone="restricted" />;
  if (backup.access === "not_obtained") return <EvidenceCard title="备份证据" eyebrow="Recovery" value="未取得" detail={`权限检查未完成；状态源 ${backup.sourceStatus}，任务记录、新鲜度和恢复演练均未取得。`} tone="unknown" />;
  const recordState = backup.latestValidRecord.state ?? "未取得";
  const value = backup.snapshotRead === "error" ? "读取失败" : backup.latestValidRecord.status === "none" ? "无记录" : recordState;
  const completeEvidence = backup.snapshotRead === "read"
    && backup.latestValidRecord.status === "available"
    && backup.latestValidRecord.state === "succeeded"
    && backup.freshness.status === "fresh"
    && backup.recoveryDrill.status === "verified";
  const tone = completeEvidence ? "ready" : backup.snapshotRead === "error" ? "attention" : backup.latestValidRecord.status === "none" || backup.freshness.status === "unknown" ? "unknown" : "attention";
  return <EvidenceCard title="备份证据" eyebrow="Recovery" value={value} detail={`状态源 ${backup.sourceStatus} · 状态读取 ${backup.snapshotRead} · 最新记录 ${recordState} · 新鲜度 ${backup.freshness.status}（阈值 ${Math.round(backup.freshness.thresholdMs / (60 * 60 * 1_000))} 小时） · 恢复演练 ${backup.recoveryDrill.status}`} tone={tone} />;
}

function EvidenceCard({ title, eyebrow, value, detail, tone }: { title: string; eyebrow: string; value: string; detail: string; tone: "ready" | "attention" | "unknown" | "restricted" }) {
  return <article className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{eyebrow}</p><h2 className="mt-2 text-lg font-semibold text-slate-950">{title}</h2><p className={`mt-4 inline-flex rounded-full px-3 py-1.5 text-sm font-semibold ${statusTone(tone)}`}>{value}</p><p className="mt-3 text-xs leading-5 text-slate-500">{detail}</p></article>;
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "emerald" | "cyan" | "violet" }) {
  const styles = { emerald: "bg-emerald-50 text-emerald-700", cyan: "bg-cyan-50 text-cyan-700", violet: "bg-violet-50 text-violet-700" } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-500">{label}</p><p className={`mt-3 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${styles[tone]}`}>{value}</p><p className="mt-3 text-xs leading-5 text-slate-500">{detail}</p></article>;
}

function Count({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-2xl bg-slate-50 px-3 py-4"><p className="text-2xl font-semibold text-slate-900">{value === undefined ? "—" : value.toLocaleString("zh-CN")}</p><p className="mt-1 text-[12px] text-slate-500">{label}</p></div>;
}
