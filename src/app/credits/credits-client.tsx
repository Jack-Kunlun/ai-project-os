"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance } from "@/components/appearance-provider";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppHeader } from "@/components/app-header";
import ui from "@/components/workspace-ui.module.css";
import credit from "./credits-client.module.css";
import { WorkspaceDialog } from "@/components/workspace-dialog";
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
  usage: { daily: Array<{ date: string; settledCredits: number; settledRawTokens: number; rawTokenCoverageComplete: boolean; pendingCredits: number }>; settledCredits: number; pendingCredits: number };
  ledger: { entries: Array<{ id: string; occurredAt: string; kind: string; kindLabel: string; operation: string | null; operationLabel: string | null; modelId: string | null; projectName: string; projectDisplay?: "name" | "unlinked" | "unavailable"; settledCredits: number; balanceDelta: number; status: string }>; page: number; pageSize: number; total: number; hasNextPage: boolean };
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

function formatNumber(value: number, language: "zh-CN" | "en"): string {
  return value.toLocaleString(language === "en" ? "en-US" : "zh-CN");
}

function formatDate(value: string | null, language: "zh-CN" | "en"): string {
  if (value === null) return language === "en" ? "No record" : "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (language === "en" ? "Unknown time" : "时间未知") : new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDay(value: string, language: "zh-CN" | "en"): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric" }).format(date);
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

function subscribeBrowserTimezone(): () => void { return () => {}; }
function serverTimezone(): string { return "UTC"; }

export function CreditsClient({ username, isSystemAdmin = false, initialProjectId = null }: { username: string; isSystemAdmin?: boolean; initialProjectId?: string | null }) {
  const { language, t } = useAppearance();
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [metric, setMetric] = useState<"credits" | "tokens">("credits");
  const [range, setRange] = useState<Report["query"]["range"]>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const detectedTimezone = useSyncExternalStore(subscribeBrowserTimezone, browserTimezone, serverTimezone);
  const [timezoneOverride, setTimezoneOverride] = useState<string | null>(null);
  const timezone = timezoneOverride ?? detectedTimezone;
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
  const [account, setAccount] = useState<Pick<Report, "summary" | "asOf"> | null>(null);
  const rememberAccount = useCallback((next: Report) => {
    setAccount(current => !current || current.asOf <= next.asOf ? { summary: next.summary, asOf: next.asOf } : current);
  }, []);
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
        if (!controller.signal.aborted) setProjectsError(t(cause instanceof Error ? cause.message : "可选项目加载失败"));
      } finally {
        if (!controller.signal.aborted) setProjectsLoading(false);
      }
    }
    void loadProjects();
    return () => controller.abort();
  }, [t]);

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
      rememberAccount(payload.report);
      setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(t(cause instanceof Error ? cause.message : "额度报表加载失败"));
    } finally { if (!signal.aborted) setLoading(false); }
  }, [from, kind, modelId, operation, page, projectId, projectsLoading, range, rememberAccount, scope, t, timezone, to]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, requestVersion]);

  const summary=account?.summary, membership=summary?.membership;
  const membershipLabel=!account?"暂无记录":membership?.status==="active"?"有效":membership?.status==="expired"?"已到期":membership?.status==="revoked"?"已撤销":"未开通";
  return <main><AppHeader username={username} active="profile" isSystemAdmin={isSystemAdmin}/><div data-page-content className={`${ui.page} ${credit.page}`}>
    <header className={ui.heading}><div><h1><UiText text="额度与账单"/></h1><p><UiText text="查看可用额度、用量趋势和额度记录。"/></p></div><div className={ui.actions}><Link href="/personal/usage" className={ui.button}><UiText text="模型 Token 记录"/> <span aria-hidden="true">↗</span></Link><button className={ui.link} onClick={()=>setMembershipOpen(true)}><UiText text="查看会员资格"/> <span aria-hidden="true">→</span></button></div></header>
    {error?<div className={ui.error} role="alert"><UiErrorText text={error} /> <button className={ui.link} onClick={()=>setRequestVersion(value=>value+1)}><UiText text="重试"/></button></div>:null}
    <div className={credit.summaryGrid} aria-label={t("额度概览")} aria-busy={!account && loading}>
      <section className={credit.summaryCard}><h2><UiText text="可用余额"/></h2><strong>{summary?formatNumber(summary.availableCredits,language):"—"}<small><UiText text="平台额度"/></small></strong><p><UiText text="额度总量"/> {summary?formatNumber(summary.totalCredits,language):"—"}</p><p className={ui.muted}><UiText text="最早到期："/>{account?formatDate(summary?.nextExpiryAt??null,language):"—"}</p></section>
      <section className={credit.summaryCard}><h2><UiText text="已结算使用"/></h2><strong>{summary?formatNumber(summary.usedCredits,language):"—"}<small><UiText text="平台额度"/></small></strong><dl className={credit.compactStats}><div><dt><UiText text="预留中"/></dt><dd>{summary?formatNumber(summary.reservedCredits,language):"—"}</dd></div><div><dt><UiText text="待核对"/></dt><dd>{summary?formatNumber(summary.heldCredits,language):"—"}</dd></div></dl><p className={ui.muted}><UiText text="预留和待核对不计入已结算使用。"/></p></section>
      <section className={credit.summaryCard}><h2><UiText text="会员资格"/></h2><strong className={credit.membershipValue}><UiText text={membershipLabel}/></strong><p>{membership?.status==="active"?<><UiText text="有效至"/> {formatDate(membership.expiresAt,language)}</>:<UiText text="在会员信息中查看资格与申请状态。"/>}</p></section>
    </div>
    <div className={credit.trendLayout}>
      <section className={credit.trend}><header className={credit.panelHeading}><div><h2><UiText text="每日用量"/></h2><p><UiText text="按"/> {report?.query.timezone??timezone} <UiText text="统计，零使用日也会保留。"/></p></div><div className={credit.ranges}>{(Object.keys(rangeLabels) as Array<Report["query"]["range"]>).map(value=><button key={value} className={ui.button} aria-pressed={range===value} onClick={()=>{setRange(value);setPage(1);}}><UiText text={rangeLabels[value]}/></button>)}</div></header>
      <div className={credit.trendBody}>
{range === "custom" ? <div className={credit.filters}><label className={ui.field}><UiText text={"账单开始日期"} /><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }}  /></label><label className={ui.field}><UiText text={"账单结束日期"} /><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }}  /></label></div> : null}
<div className={credit.filters}><label className={ui.field}><UiText text={"统计范围"} /><select value={scope} onChange={(event) => { const next = event.target.value as Report["query"]["scope"]; setScope(next); setPage(1); }} >{scopeOptions.map(([value, label]) => <option key={value} value={value}><UiText text={label} /></option>)}</select></label><label className={ui.field}><UiText text={"统计时区"} /><select value={timezone} onChange={(event) => { setTimezoneOverride(event.target.value); setPage(1); }} ><option value="UTC">UTC</option><option value="Asia/Shanghai">Asia/Shanghai</option><option value="Asia/Tokyo">Asia/Tokyo</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label><label className={ui.field}><UiText text={"操作类型"} /><select value={operation} onChange={(event) => { setOperation(event.target.value as Report["query"]["operation"]); setPage(1); }} >{operationOptions.map(([value, label]) => <option key={value} value={value}><UiText text={label} /></option>)}</select></label><label className={ui.field}><UiText text={"模型筛选"} /><input value={modelId} onChange={(event) => { setModelId(event.target.value); setPage(1); }} placeholder={t("输入模型标识")}  /></label></div>{scope === "project" ? <label className={ui.field}><UiText text={"项目"} /><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }} disabled={projectsLoading || projects.length === 0} >{projectsLoading ? <option value=""><UiText text={"正在加载项目…"} /></option> : projects.length === 0 ? <option value=""><UiText text={"暂无可访问项目"} /></option> : projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? t("（已归档）") : ""}</option>)}</select></label> : null}
        {scope === "project" && projectsError ? <p className={ui.error} role="alert"><UiErrorText text={projectsError} /></p> : null}
      <div className={credit.metricTabs} aria-label={t("用量展示方式")}><button aria-pressed={metric==="credits"} onClick={()=>setMetric("credits")}><UiText text="额度趋势"/></button><button aria-pressed={metric==="tokens"} onClick={()=>setMetric("tokens")}><UiText text="Token 活动"/></button></div>
      {loading?<p className={ui.empty} role="status"><UiText text="读取中…"/></p>:report?<>{metric==="tokens"?<TokenActivity daily={report.usage.daily}/>:<CreditTrend report={report} language={language}/>}<p className={credit.periodSummary}><UiText text="所选周期已结算"/> <strong>{formatNumber(report.usage.settledCredits,language)}</strong> <UiText text="平台额度"/><span><UiText text="待核对"/> {formatNumber(report.usage.pendingCredits,language)}</span></p></>:<p className={ui.empty}><UiText text={range==="custom"&&(!from||!to)?"请选择起止日期":scope==="project"&&!projectId?"暂无可访问项目":"暂无记录"}/></p>}
      </div></section>
      <aside className={credit.rules}><header className={credit.panelHeading}><h2><UiText text="额度规则"/></h2></header><div className={credit.rulesBody}><dl><div><dt><UiText text="统计单位"/></dt><dd><UiText text="平台额度"/></dd></div><div><dt><UiText text="模型用量"/></dt><dd><Link href="/personal/usage" className={ui.link}><UiText text="模型 Token 记录"/> <span aria-hidden="true">→</span></Link></dd></div><div><dt><UiText text="预留与待核对"/></dt><dd><UiText text="暂不可用，完成后结算或释放"/></dd></div></dl><p><UiText text="平台额度与模型原始 Token 分开统计。"/></p><p><UiText text="额度流水保留发放、预留、结算、释放和调整记录。"/></p></div></aside>
    </div>
<section className={credit.ledger}><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600"><UiText text={"账单记录"} /></p><h2 className="mt-2 text-xl font-semibold"><UiText text={"账单记录"} /></h2><p className="mt-1.5 text-sm text-slate-500"><UiText text={"账单展示平台额度记录，不是支付订单或发票。"} /></p></div><label className="text-xs font-semibold text-slate-600"><UiText text={"流水类型"} /><select value={kind} onChange={(event) => { setKind(event.target.value as Report["query"]["kind"]); setPage(1); }} className="mt-2 block min-h-10 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal">{kindOptions.map(([value, label]) => <option key={value} value={value}><UiText text={label} /></option>)}</select></label></div>
        {report ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[820px] text-center text-sm"><thead className="border-b border-slate-100 text-xs text-slate-400"><tr><th className="pb-3 pr-4 font-medium"><UiText text={"时间"} /></th><th className="pb-3 pr-4 font-medium"><UiText text={"类型"} /></th><th className="pb-3 pr-4 font-medium"><UiText text={"项目 / 操作"} /></th><th className="pb-3 pr-4 text-center font-medium"><UiText text={"结算消耗"} /></th><th className="pb-3 pr-4 text-center font-medium"><UiText text={"可用余额变化"} /></th><th className="pb-3 text-center font-medium"><UiText text={"状态"} /></th></tr></thead><tbody className="divide-y divide-slate-100">{report.ledger.entries.map((entry) => <tr key={entry.id}><td className="py-4 pr-4 whitespace-nowrap text-xs text-slate-500">{formatDate(entry.occurredAt, language)}</td><td className="py-4 pr-4"><span className="font-semibold text-slate-700"><UiText text={entry.kindLabel} /></span></td><td className="py-4 pr-4"><span className="block text-slate-700">{entry.projectDisplay === "unlinked" ? t("未关联项目") : entry.projectDisplay === "unavailable" ? t("项目已不可见") : entry.projectName}</span><span className="mt-1 block text-xs text-slate-400"><UiText text={entry.operationLabel ?? "未关联操作"} />{entry.modelId ? ` · ${entry.modelId}` : ""}</span></td><td className="py-4 pr-4 text-center font-semibold text-slate-700">{entry.settledCredits ? formatNumber(entry.settledCredits, language) : "—"}</td><td className={`py-4 pr-4 text-center font-semibold ${entry.balanceDelta > 0 ? "text-emerald-700" : entry.balanceDelta < 0 ? "text-rose-700" : "text-slate-400"}`}>{entry.balanceDelta > 0 ? "+" : ""}{formatNumber(entry.balanceDelta, language)}</td><td className="py-4 text-center text-xs text-slate-500"><UiText text={entry.status === "pending" ? "待核对" : entry.status === "expired" ? "已到期" : entry.status === "revoked" ? "已撤销" : entry.status === "reserved" ? "预留中" : entry.status === "settled" ? "已结算" : entry.status === "released" ? "已释放" : entry.status === "adjusted" ? "已调整" : "有效"} /></td></tr>)}</tbody></table>{report.ledger.entries.length === 0 ? <p className="py-14 text-center text-sm text-slate-400"><UiText text={"当前筛选范围暂无额度流水"} /></p> : null}</div> : null}
        {report ? <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-xs text-slate-500"><span><UiText text={"共"} /> {formatNumber(report.ledger.total, language)} <UiText text={"条额度记录"} /></span><div className="flex gap-2"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold disabled:opacity-40"><UiText text={"上一页"} /></button><span className="px-2 py-2">{language === "en" ? `Page ${report.ledger.page}` : `第 ${report.ledger.page} 页`}</span><button type="button" disabled={!report.ledger.hasNextPage || loading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold disabled:opacity-40"><UiText text={"下一页"} /></button></div></div> : null}
      </section>
    <p className={credit.updated}><UiText text="单位：平台额度；更新时间："/>{report||account?formatDate((report??account)!.asOf,language):t(loading?"读取中…":"暂无记录")}</p>
    <MembershipApplicationCard onSnapshot={rememberAccount} open={membershipOpen} onClose={()=>setMembershipOpen(false)} onChanged={()=>setRequestVersion(value=>value+1)}/>
  </div></main>;
}

function CreditTrend({report,language}:{report:Report;language:"zh-CN"|"en"}){
  const {t}=useAppearance(),daily=report.usage.daily,max=Math.max(1,...daily.map(point=>point.settledCredits));
  if(!daily.length)return <p className={ui.empty}><UiText text="当前筛选范围暂无用量记录"/></p>;
  return <><figure className={credit.chart} aria-label={`${t("额度趋势")} · ${formatNumber(report.usage.settledCredits,language)} ${t("平台额度")}`}><svg viewBox="0 0 720 180" role="img" aria-label={t("每日已结算额度")} preserveAspectRatio="none"><line x1="0" y1="179" x2="720" y2="179"/>{daily.map((point,index)=>{const step=720/daily.length,height=point.settledCredits===0?1:Math.max(2,point.settledCredits/max*160);return <rect key={point.date} x={index*step+Math.min(4,step/8)} y={179-height} width={Math.max(.5,step-Math.min(8,step/4))} height={height}><title>{point.date} · {formatNumber(point.settledCredits,language)} {t("平台额度")}</title></rect>;})}</svg><figcaption><time>{formatDay(daily[0].date,language)}</time>{daily.length>2?<time>{formatDay(daily[Math.floor(daily.length/2)].date,language)}</time>:null}<time>{formatDay(daily.at(-1)!.date,language)}</time></figcaption></figure><details className={credit.dailyDetails}><summary><UiText text="查看每日数值"/></summary><div className={credit.dailyTable}><table><caption className="sr-only"><UiText text="每日已结算额度"/></caption><thead><tr><th><UiText text="日期"/></th><th><UiText text="已结算使用"/></th></tr></thead><tbody>{daily.map(point=><tr key={point.date}><td>{point.date}</td><td>{formatNumber(point.settledCredits,language)}</td></tr>)}</tbody></table></div></details></>;
}

function MembershipApplicationCard({ onSnapshot, onChanged, open, onClose }: { onSnapshot: (report: Report) => void; onChanged: () => void; open: boolean; onClose: () => void }) {
  const { language, t } = useAppearance();
  const [report, setReport] = useState<Report | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  // Membership is account-wide and remains available when usage filters are incomplete.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function readAccount() {
      setSnapshotLoading(true); setSnapshotError(null);
      try {
        const response = await fetch("/api/credits?range=7d&timezone=UTC&page=1&pageSize=1", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await readError(response, "会员信息读取失败"));
        const { report: next } = await response.json() as { report: Report };
        if (!controller.signal.aborted) { setReport(next); onSnapshot(next); }
      } catch (cause) {
        if (!controller.signal.aborted) setSnapshotError(cause instanceof Error ? cause.message : "会员信息读取失败");
      } finally { if (!controller.signal.aborted) setSnapshotLoading(false); }
    }
    const timer = window.setTimeout(() => void readAccount(), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, refresh, onSnapshot]);
  const application = report?.membershipApplication ?? null;
  const membership = report?.summary.membership.status ?? "none";
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestKey = useRef(newRequestKey("membership-application"));
  const canApply = !snapshotLoading && !snapshotError && report !== null && membership !== "active" && (application === null || application.status !== "pending");

  function cancelPreview() {
    setPreview(null);
    requestKey.current = newRequestKey("membership-application");
  }

  async function operationError(response: Response, fallback: string): Promise<Error> {
    const failure = await safeResponseError(response, fallback);
    if (failure.code === "MEMBERSHIP_APPLICATION_PREVIEW_EXPIRED" || failure.code === "MEMBERSHIP_APPLICATION_PREVIEW_STALE") {
      cancelPreview(); setRefresh(value => value + 1);
      return new Error("预览已失效，请核对最新状态后重新预览，申请说明已保留。");
    }
    // An uncertain execution keeps the original key, so retry can recover its recorded outcome.
    return new Error(failure.message);
  }

  async function previewSubmit() {
    if (!reason.trim()) { setMessage("请填写申请说明"); return; }
    setPending(true); setMessage(null); setNotice(null);
    try {
      const response = await fetch("/api/profile/membership-applications/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: requestKey.current, reason }) });
      if (!response.ok) throw await operationError(response, "会员申请预览失败");
      setPreview(await response.json() as Preview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "会员申请预览失败"); } finally { setPending(false); }
  }

  async function previewWithdraw() {
    if (!application) return;
    requestKey.current = newRequestKey("membership-withdraw"); setPending(true); setMessage(null); setNotice(null);
    try {
      const response = await fetch("/api/profile/membership-applications/withdraw/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationId: application.id, requestKey: requestKey.current }) });
      if (!response.ok) throw await operationError(response, "撤回申请预览失败");
      setPreview(await response.json() as Preview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "撤回申请预览失败"); } finally { setPending(false); }
  }

  async function execute() {
    if (!preview) return;
    setPending(true); setMessage(null); setNotice(null);
    try {
      const endpoint = preview.preview.action === "submit" ? "/api/profile/membership-applications/execute" : "/api/profile/membership-applications/withdraw/execute";
      const body = { previewId: preview.preview.id, requestKey: preview.preview.requestKey, requestFingerprint: preview.preview.requestFingerprint, impactFingerprint: preview.preview.impactFingerprint, previewIssuedAt: preview.preview.issuedAt, previewExpiresAt: preview.preview.expiresAt, confirmation: true, ...(preview.preview.action === "withdraw" ? { applicationId: preview.preview.applicationId } : {}) };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw await operationError(response, "会员申请执行失败");
      setPreview(null); requestKey.current = newRequestKey("membership-application"); setNotice(preview.preview.action === "submit" ? "申请已提交，管理员会在平台内处理。" : "申请已撤回。"); setRefresh(value => value + 1); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "会员申请执行失败"); } finally { setPending(false); }
  }

  return <WorkspaceDialog title={t("会员信息")} open={open} onClose={onClose} busy={pending}><section className={credit.membership}>{snapshotLoading ? <p role="status"><UiText text="读取中…"/></p> : null}{snapshotError ? <p role="alert" className={ui.error}><UiErrorText text={snapshotError} /> <button className={ui.link} onClick={()=>setRefresh(value=>value+1)}><UiText text="重试"/></button></p> : null}<dl className={credit.membershipMeta}><div><dt><UiText text="会员资格"/></dt><dd>{!report?t(snapshotLoading?"读取中…":"暂无记录"):t(membership==="active"?"有效":membership==="expired"?"已到期":membership==="revoked"?"已撤销":"未开通")}</dd></div><div><dt><UiText text="有效期"/></dt><dd>{report?.summary.membership.expiresAt?formatDate(report.summary.membership.expiresAt,language):"—"}</dd></div>{application?<div><dt><UiText text="申请状态"/></dt><dd><UiText text={applicationStatus(application.status)}/></dd></div>:null}</dl>{application ? <p className="mt-4 text-xs text-slate-500"><UiText text={"申请于"} /> {formatDate(application.submittedAt, language)} <UiText text={"提交；状态更新时间："} />{formatDate(application.fulfilledAt ?? application.rejectedAt ?? application.withdrawnAt, language)}</p> : null}{application?.status === "pending" ? <button type="button" disabled={pending || snapshotLoading || !!snapshotError} onClick={() => void previewWithdraw()} className={ui.button}><UiText text={"预览撤回申请"} /></button> : null}{canApply ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 px-4 py-4"><p className="text-sm font-semibold text-slate-800"><UiText text={"申请管理员开通"} /></p><p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"管理员会在平台内审核申请，处理结果可在这里查看。"} /></p><label className={ui.field}><UiText text="申请说明"/><textarea aria-label={t("申请说明")} disabled={pending} value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); requestKey.current=newRequestKey("membership-application"); }} maxLength={500} rows={3} placeholder={t("请说明申请原因")} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /></label><button type="button" disabled={pending || preview !== null} onClick={() => void previewSubmit()} className={`${ui.button} ${ui.primary}`}><UiText text={"预览申请"} /></button></div> : null}{preview ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4"><p className="text-sm font-semibold text-amber-900"><UiText text={"请确认"} /><UiText text={preview.preview.action === "submit" ? "提交会员申请" : "撤回会员申请"} /></p><p className="mt-3 text-sm">{preview.preview.reason}</p><p className="mt-1 text-xs leading-5 text-amber-800"><UiText text={"预览有效至"} /> {formatDate(preview.preview.expiresAt, language)}。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => void execute()} className={`${ui.button} ${ui.primary}`}><UiText text={"确认并执行"} /></button><button type="button" disabled={pending} onClick={cancelPreview} className={ui.button}><UiText text={"取消"} /></button></div></div> : null}{notice?<p role="status" className={ui.notice}><UiFeedbackText text={notice} /></p>:null}{message ? <p role="alert" className={ui.error}><UiFeedbackText text={message} /></p> : null}</section></WorkspaceDialog>;
}
