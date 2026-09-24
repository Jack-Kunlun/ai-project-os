"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { TokenActivity } from "@/components/token-activity";
import { safeResponseError } from "@/lib/safe-error-presentation";

type MembershipApplication = {
  id: string;
  status: "pending" | "fulfilled" | "rejected" | "withdrawn";
  statusVersion: number;
  submittedAt: string;
  fulfilledAt: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
};

type Report = {
  asOf: string;
  query: {
    range: "7d" | "30d" | "90d" | "365d" | "custom";
    from: string | null;
    to: string | null;
    timezone: string;
    page: number;
    pageSize: number;
    kind: "all" | "grant" | "reserve" | "settle" | "release" | "hold" | "adjustment";
    operation: "all" | "embedding" | "visionExtract" | "autoExtract" | "sourceSummary" | "projectAnalysis" | "generateWithContext";
    modelId: string | null;
    projectId: string | null;
    scope: "all" | "personal" | "project";
    window: { from: string; to: string; fromDate: string; toDate: string; days: string[] };
  };
  summary: {
    unit: "platform_credit";
    totalCredits: number;
    availableCredits: number;
    usedCredits: number;
    reservedCredits: number;
    heldCredits: number;
    nextExpiryAt: string | null;
    membership: { status: "active" | "expired" | "revoked" | "none"; startsAt: string | null; expiresAt: string | null; version: number | null };
    routeSnapshots: Array<{ operation: string; version: number; quotaMultiplierBps: number }>;
  };
  usage: { daily: Array<{ date: string; settledCredits: number; settledRawTokens: number; pendingCredits: number }>; settledCredits: number; pendingCredits: number };
  ledger: { entries: Array<{ id: string; occurredAt: string; kind: string; kindLabel: string; operation: string | null; operationLabel: string | null; modelId: string | null; projectName: string; settledCredits: number; balanceDelta: number; status: string }>; page: number; pageSize: number; total: number; hasNextPage: boolean };
  membershipApplication: MembershipApplication | null;
};

type Preview = {
  application: MembershipApplication | null;
  preview: { id: string; action: "submit" | "withdraw"; applicationId: string | null; requestKey: string; requestFingerprint: string; impactFingerprint: string; issuedAt: string; expiresAt: string; reason: string | null };
};

const rangeLabels = { "7d": "近 7 天", "30d": "近 30 天", "90d": "近 90 天", "365d": "近一年", custom: "自定义" } as const;
const kindOptions = [
  ["all", "全部流水"], ["grant", "额度发放"], ["settle", "使用结算"], ["reserve", "预留"], ["release", "释放"], ["hold", "待核对"], ["adjustment", "额度调整"],
] as const;
const operationOptions = [
  ["all", "全部操作"], ["embedding", "向量索引"], ["visionExtract", "图片识别"], ["autoExtract", "自动抽取"], ["sourceSummary", "资料摘要"], ["projectAnalysis", "项目分析"], ["generateWithContext", "引用式生成"],
] as const;
const scopeOptions = [["all", "全部范围"], ["personal", "个人用量"], ["project", "项目用量"]] as const;
type ProjectOption = { id: string; name: string; archivedAt: string | null };

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDate(value: string | null): string {
  if (value === null) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function newRequestKey(prefix: string): string {
  try { return `${prefix}:${globalThis.crypto.randomUUID()}`; } catch { return `${prefix}:${Date.now().toString(36)}`; }
}

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function applicationStatus(status: MembershipApplication["status"]): string {
  return status === "pending" ? "等待管理员处理" : status === "fulfilled" ? "申请已完成" : status === "rejected" ? "申请未通过" : "已撤回";
}

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function CreditsClient({ username, isSystemAdmin = false, initialProjectId = null }: { username: string; isSystemAdmin?: boolean; initialProjectId?: string | null }) {
  const [range, setRange] = useState<Report["query"]["range"]>("365d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [kind, setKind] = useState<Report["query"]["kind"]>("all");
  const [operation, setOperation] = useState<Report["query"]["operation"]>("all");
  const [modelId, setModelId] = useState("");
  const [scope, setScope] = useState<Report["query"]["scope"]>(initialProjectId ? "project" : "all");
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function loadProjects() {
      try {
        const collected: ProjectOption[] = [];
        for (const view of ["active", "archived"] as const) {
          for (let pageNumber = 1; ; pageNumber += 1) {
            const response = await fetch(`/api/projects?view=${view}&page=${pageNumber}&pageSize=50`, { cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(await readError(response, "可选项目加载失败"));
            const payload = await response.json() as { projects: ProjectOption[]; pagination: { totalPages: number } };
            collected.push(...payload.projects);
            if (pageNumber >= payload.pagination.totalPages) break;
          }
        }
        if (controller.signal.aborted) return;
        setProjects(collected);
        setProjectsError(null);
        setProjectId((current) => collected.some((project) => project.id === current) ? current : collected[0]?.id ?? "");
      } catch (cause) {
        if (!controller.signal.aborted) setProjectsError(cause instanceof Error ? cause.message : "可选项目加载失败");
      } finally {
        if (!controller.signal.aborted) setProjectsLoading(false);
      }
    }
    void loadProjects();
    return () => controller.abort();
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    if (range === "custom" && (!from || !to)) {
      setLoading(false);
      setReport(null);
      setError(null);
      return;
    }
    if (scope === "project" && (projectsLoading || !projectId)) {
      setLoading(false);
      setReport(null);
      setError(null);
      return;
    }
    setLoading(true);
    setReport(null);
    const params = new URLSearchParams({ range, timezone, page: String(page), pageSize: "20", kind, operation, scope });
    if (range === "custom") { params.set("from", from); params.set("to", to); }
    if (modelId.trim()) params.set("modelId", modelId.trim());
    if (scope === "project") params.set("projectId", projectId.trim());
    try {
      const response = await fetch(`/api/credits?${params.toString()}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(await readError(response, "额度报表加载失败"));
      const payload = await response.json() as { report: Report };
      if (signal.aborted) return;
      setReport(payload.report);
      setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "额度报表加载失败");
    } finally { if (!signal.aborted) setLoading(false); }
  }, [from, kind, modelId, operation, page, projectId, projectsLoading, range, scope, timezone, to]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, requestVersion]);

  const status = report?.summary.membership.status ?? "none";
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
    <AppHeader username={username} active="profile" isSystemAdmin={isSystemAdmin} />
    <div className="mx-auto max-w-7xl px-5 pb-16 pt-9 sm:px-8 lg:px-10">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Personal billing</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">额度与账单</h1><p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">查看当前平台额度、已结算用量和额度流水。这里的账单是平台额度记录，不是支付订单或发票。</p></div>
        <Link href="/profile" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700">账号与安全</Link>
      </section>

      {error ? <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => setRequestVersion((value) => value + 1)} className="font-semibold underline">重试</button></div> : null}
      <section className="mt-7 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Platform credits</p><h2 className="mt-2 text-xl font-semibold">额度概览</h2><p className="mt-1.5 text-sm text-slate-500">单位：平台额度；更新时间：{report ? formatDate(report.asOf) : "读取中…"}</p></div><div className="text-right text-xs text-slate-500"><p>会员：{status === "active" ? `有效至 ${formatDate(report?.summary.membership.expiresAt ?? null)}` : status === "none" ? "未开通" : status === "expired" ? "已到期" : "已撤销"}</p><p className="mt-1">最早到期：{formatDate(report?.summary.nextExpiryAt ?? null)}</p></div></div>
        <dl className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-slate-100 bg-slate-100 sm:grid-cols-2 lg:grid-cols-5"><CreditStat label="额度总量" value={report ? formatNumber(report.summary.totalCredits) : "…"} /><CreditStat label="已结算使用" value={report ? formatNumber(report.summary.usedCredits) : "…"} /><CreditStat label="预留中" value={report ? formatNumber(report.summary.reservedCredits) : "…"} /><CreditStat label="待核对" value={report ? formatNumber(report.summary.heldCredits) : "…"} /><CreditStat label="可用余额" value={report ? formatNumber(report.summary.availableCredits) : "…"} tone="success" /></dl>
        <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-xs leading-5 text-slate-600"><p className="font-semibold text-slate-700">统计口径</p><p className="mt-1">已结算使用来自 reservation allocation 的 settledTokens；流水中的“可用余额变化”来自追加式额度流水。预留和待核对不计入已结算使用。</p></div>
      </section>

      <MembershipApplicationCard report={report} onChanged={() => setRequestVersion((value) => value + 1)} />

      <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Usage report</p><h2 className="mt-2 text-xl font-semibold">每日用量</h2><p className="mt-1.5 text-sm text-slate-500">按 {report?.query.timezone ?? timezone} 统计，零使用日也会保留。</p></div><div className="flex flex-wrap gap-2">{(Object.keys(rangeLabels) as Array<Report["query"]["range"]>).map((value) => <button key={value} type="button" onClick={() => { setRange(value); setPage(1); }} className={`rounded-xl px-3.5 py-2 text-xs font-semibold transition ${range === value ? "bg-slate-950 text-white" : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700"}`}>{rangeLabels[value]}</button>)}</div></div>
        {range === "custom" ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">开始日期<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal" /></label><label className="text-xs font-semibold text-slate-600">结束日期<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal" /></label></div> : null}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-xs font-semibold text-slate-600">统计范围<select value={scope} onChange={(event) => { const next = event.target.value as Report["query"]["scope"]; setScope(next); setPage(1); }} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal">{scopeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-xs font-semibold text-slate-600">统计时区<select value={timezone} onChange={(event) => { setTimezone(event.target.value); setPage(1); }} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal"><option value="UTC">UTC</option><option value="Asia/Shanghai">Asia/Shanghai</option><option value="Asia/Tokyo">Asia/Tokyo</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label><label className="text-xs font-semibold text-slate-600">操作类型<select value={operation} onChange={(event) => { setOperation(event.target.value as Report["query"]["operation"]); setPage(1); }} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal">{operationOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-xs font-semibold text-slate-600">模型筛选<input value={modelId} onChange={(event) => { setModelId(event.target.value); setPage(1); }} placeholder="输入模型标识" className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal" /></label></div>{scope === "project" ? <label className="mt-3 block text-xs font-semibold text-slate-600">项目<select value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }} disabled={projectsLoading || projects.length === 0} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal disabled:opacity-60">{projectsLoading ? <option value="">正在加载项目…</option> : projects.length === 0 ? <option value="">暂无可访问项目</option> : projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? "（已归档）" : ""}</option>)}</select></label> : null}
        {scope === "project" && projectsError ? <p role="alert" className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700">{projectsError}</p> : null}
        {loading && !report ? <div className="mt-6 h-56 animate-pulse rounded-2xl bg-slate-50" /> : report ? <div className="mt-6"><dl className="grid gap-3 sm:grid-cols-3"><div className="rounded-2xl bg-indigo-50 px-4 py-4"><dt className="text-xs font-semibold text-indigo-700">{report.usage.daily.at(-1) ? formatDay(report.usage.daily.at(-1)!.date) : "末日"}已结算</dt><dd className="mt-2 text-2xl font-semibold text-slate-900">{formatNumber(report.usage.daily.at(-1)?.settledCredits ?? 0)}</dd></div><div className="rounded-2xl bg-slate-50 px-4 py-4"><dt className="text-xs font-semibold text-slate-600">所选周期已结算</dt><dd className="mt-2 text-2xl font-semibold text-slate-900">{formatNumber(report.usage.settledCredits)}</dd></div><div className="rounded-2xl bg-amber-50 px-4 py-4"><dt className="text-xs font-semibold text-amber-700">待核对</dt><dd className="mt-2 text-2xl font-semibold text-slate-900">{formatNumber(report.usage.pendingCredits)}</dd></div></dl><div className="mt-6"><TokenActivity daily={report.usage.daily} /></div></div> : null}
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Ledger</p><h2 className="mt-2 text-xl font-semibold">账单记录</h2><p className="mt-1.5 text-sm text-slate-500">流水保留真实额度变化，项目名称只在当前仍有访问权时展示。</p></div><label className="text-xs font-semibold text-slate-600">流水类型<select value={kind} onChange={(event) => { setKind(event.target.value as Report["query"]["kind"]); setPage(1); }} className="mt-2 block min-h-10 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal">{kindOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        {report ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[820px] text-center text-sm"><thead className="border-b border-slate-100 text-xs text-slate-400"><tr><th className="pb-3 pr-4 font-medium">时间</th><th className="pb-3 pr-4 font-medium">类型</th><th className="pb-3 pr-4 font-medium">项目 / 操作</th><th className="pb-3 pr-4 text-center font-medium">结算消耗</th><th className="pb-3 pr-4 text-center font-medium">可用余额变化</th><th className="pb-3 text-center font-medium">状态</th></tr></thead><tbody className="divide-y divide-slate-100">{report.ledger.entries.map((entry) => <tr key={entry.id}><td className="py-4 pr-4 whitespace-nowrap text-xs text-slate-500">{formatDate(entry.occurredAt)}</td><td className="py-4 pr-4"><span className="font-semibold text-slate-700">{entry.kindLabel}</span></td><td className="py-4 pr-4"><span className="block text-slate-700">{entry.projectName}</span><span className="mt-1 block text-xs text-slate-400">{entry.operationLabel ?? "未关联操作"}{entry.modelId ? ` · ${entry.modelId}` : ""}</span></td><td className="py-4 pr-4 text-center font-semibold text-slate-700">{entry.settledCredits ? formatNumber(entry.settledCredits) : "—"}</td><td className={`py-4 pr-4 text-center font-semibold ${entry.balanceDelta > 0 ? "text-emerald-700" : entry.balanceDelta < 0 ? "text-rose-700" : "text-slate-400"}`}>{entry.balanceDelta > 0 ? "+" : ""}{formatNumber(entry.balanceDelta)}</td><td className="py-4 text-center text-xs text-slate-500">{entry.status === "pending" ? "待核对" : entry.status === "expired" ? "已到期" : entry.status === "revoked" ? "已撤销" : entry.status === "reserved" ? "预留中" : entry.status === "settled" ? "已结算" : entry.status === "released" ? "已释放" : entry.status === "adjusted" ? "已调整" : "有效"}</td></tr>)}</tbody></table>{report.ledger.entries.length === 0 ? <p className="py-14 text-center text-sm text-slate-400">当前筛选范围暂无额度流水</p> : null}</div> : null}
        {report ? <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-xs text-slate-500"><span>共 {formatNumber(report.ledger.total)} 条记录</span><div className="flex gap-2"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold disabled:opacity-40">上一页</button><span className="px-2 py-2">第 {report.ledger.page} 页</span><button type="button" disabled={!report.ledger.hasNextPage || loading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold disabled:opacity-40">下一页</button></div></div> : null}
      </section>

      <section className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-white/70 px-5 py-5 text-sm text-slate-500 shadow-sm sm:px-7"><p className="font-semibold text-slate-700">后续购买能力</p><p className="mt-1.5 leading-6">后续版本可在这里扩展产品、订单、支付、退款与发票的对账能力。本版本不提供购买或充值入口。</p></section>
    </div>
  </main>;
}

function CreditStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" }) {
  return <div className="bg-slate-50/80 px-5 py-4"><dt className="text-xs font-medium text-slate-400">{label}</dt><dd className={`mt-2 text-lg font-semibold ${tone === "success" ? "text-emerald-700" : "text-slate-800"}`}>{value}</dd></div>;
}

function MembershipApplicationCard({ report, onChanged }: { report: Report | null; onChanged: () => void }) {
  const application = report?.membershipApplication ?? null;
  const membership = report?.summary.membership.status ?? "none";
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestKey = useRef(newRequestKey("membership-application"));
  const canApply = membership !== "active" && (application === null || application.status !== "pending");

  async function previewSubmit() {
    if (!reason.trim()) { setMessage("请填写申请说明"); return; }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile/membership-applications/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: requestKey.current, reason }) });
      if (!response.ok) throw new Error(await readError(response, "会员申请预览失败"));
      setPreview(await response.json() as Preview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "会员申请预览失败"); } finally { setPending(false); }
  }

  async function previewWithdraw() {
    if (!application) return;
    requestKey.current = newRequestKey("membership-withdraw"); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile/membership-applications/withdraw/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationId: application.id, requestKey: requestKey.current }) });
      if (!response.ok) throw new Error(await readError(response, "撤回申请预览失败"));
      setPreview(await response.json() as Preview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "撤回申请预览失败"); } finally { setPending(false); }
  }

  async function execute() {
    if (!preview) return;
    setPending(true); setMessage(null);
    try {
      const endpoint = preview.preview.action === "submit" ? "/api/profile/membership-applications/execute" : "/api/profile/membership-applications/withdraw/execute";
      const body = { previewId: preview.preview.id, requestKey: preview.preview.requestKey, requestFingerprint: preview.preview.requestFingerprint, impactFingerprint: preview.preview.impactFingerprint, previewIssuedAt: preview.preview.issuedAt, previewExpiresAt: preview.preview.expiresAt, confirmation: true, ...(preview.preview.action === "withdraw" ? { applicationId: preview.preview.applicationId } : {}) };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await readError(response, "会员申请执行失败"));
      setPreview(null); requestKey.current = newRequestKey("membership-application"); setMessage(preview.preview.action === "submit" ? "申请已提交，管理员会在平台内处理。" : "申请已撤回。"); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "会员申请执行失败"); } finally { setPending(false); }
  }

  return <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Membership</p><h2 className="mt-2 text-lg font-semibold">会员信息</h2><p className="mt-1.5 text-sm text-slate-500">会员状态影响个人模型与项目委托能力，额度报表本身只读取平台额度记录。</p></div>{application ? <span className="rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700">{applicationStatus(application.status)}</span> : null}</div>{application ? <p className="mt-4 text-xs text-slate-500">申请于 {formatDate(application.submittedAt)} 提交；状态更新时间：{formatDate(application.fulfilledAt ?? application.rejectedAt ?? application.withdrawnAt)}</p> : null}{application?.status === "pending" ? <button type="button" disabled={pending} onClick={() => void previewWithdraw()} className="mt-4 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-50">预览撤回申请</button> : null}{canApply ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 px-4 py-4"><p className="text-sm font-semibold text-slate-800">申请管理员开通</p><p className="mt-1 text-xs leading-5 text-slate-500">提交后只会生成可追踪申请，不包含支付、订单或自动开通承诺。</p><textarea value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }} maxLength={500} rows={3} placeholder="请说明申请原因" className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /><button type="button" disabled={pending} onClick={() => void previewSubmit()} className="mt-3 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">预览申请</button></div> : null}{preview ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4"><p className="text-sm font-semibold text-amber-900">请确认{preview.preview.action === "submit" ? "提交会员申请" : "撤回会员申请"}</p><p className="mt-1 text-xs leading-5 text-amber-800">预览有效至 {formatDate(preview.preview.expiresAt)}。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => void execute()} className="rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button><button type="button" disabled={pending} onClick={() => setPreview(null)} className="rounded-xl border border-amber-200 bg-white px-4 py-2.5 text-xs font-semibold text-amber-800">取消</button></div></div> : null}{message ? <p role="alert" className="mt-4 text-xs text-rose-700">{message}</p> : null}</section>;
}
