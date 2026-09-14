"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { automationFailurePresentation } from "@/lib/automation-failure-presentation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";

type RuleKind = "repositorySync" | "memoryQuality" | "memoryIndex" | "projectBrief" | "webSourceSync" | "projectPlanHealth";
type AutomationRunResult = {
  availability: "available" | "unavailable";
  kind: "waitingConsent" | "webSourceSync" | "memoryQuality" | "projectPlanHealth" | "repositorySync" | "unknown";
  reason?: "not_available" | "invalid" | "too_large" | "unsupported";
  delivery?: "waitingConsent" | "localNotification";
  modelSelection?: "deferred_to_ai_workbench";
  billing?: "none";
  externalTransfer?: false;
  notificationOnly?: true;
  successCount?: number | null;
  failedCount?: number | null;
  failures?: Array<{ failureCode: string }>;
  score?: number | null;
  openIssueCount?: number | null;
  healthStatus?: "empty" | "healthy" | "attention" | "atRisk" | null;
  counts?: Record<string, number | null>;
  notifiedUserCount?: number | null;
};
type AutomationRun = { id: string; automationRuleId?: string; projectId?: string; status: string; scheduledFor: string; failureCode: string | null; completedAt: string | null; createdAt?: string; jobIds?: string[]; result: AutomationRunResult | null; rule?: { name: string; kind: RuleKind } };
type AutomationRule = {
  id: string;
  name: string;
  kind: RuleKind;
  status: "active" | "paused";
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string | null;
  consecutiveFailures: number;
  runs: AutomationRun[];
};

type AutomationCapabilities = { permission: "view" | "edit" | "owner"; canCreate: boolean; canManage: boolean; canRunNow: boolean };
type AutomationPreview = {
  firstRunAtUtc: string;
  firstRunAtBrowserTime: string;
  browserTimeZone: string;
  intervalMinutes: number;
  name: string;
  kind: RuleKind;
  scope: {
    label: string;
    sourceCount: number;
    safeDomains: string[];
    notification: { audience: "creator" | "creatorAndEligibleAssignees"; condition: "always" | "onFailure" | "waitingConsent"; count: number };
    modelExternalTransfer: boolean;
    requiresConfirmation: boolean;
    delivery: "localNotification" | "waitingConsent";
  };
  requiresConfirmation: boolean;
  modelSelection: string;
  billing: string;
  transfer: string;
  previewFingerprint: string;
  canonicalPayload: {
    name: string;
    kind: RuleKind;
    intervalMinutes: number;
    config: Record<string, unknown>;
    startAtUtc: string;
    scope: AutomationPreview["scope"];
  };
};

const readOnlyCapabilities: AutomationCapabilities = { permission: "view", canCreate: false, canManage: false, canRunNow: false };

const kindLabels: Record<RuleKind, string> = {
  repositorySync: "代码仓库同步",
  memoryQuality: "记忆质量检查",
  memoryIndex: "增量记忆索引",
  projectBrief: "项目状态简报",
  webSourceSync: "网页来源刷新",
  projectPlanHealth: "项目计划健康提醒",
};
const runStatusLabels: Record<string, string> = { queued: "排队中", running: "运行中", waitingConsent: "等待确认", succeeded: "已完成", failed: "失败", skipped: "已跳过" };
type NotificationFilter = "all" | "unread" | "pending" | "system";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

function parseNotificationFilter(value: string | null): NotificationFilter {
  return value === "unread" || value === "pending" || value === "system" ? value : "all";
}

function parseNotificationCursor(value: string | null): string | null {
  return value !== null && CURSOR_PATTERN.test(value) ? value : null;
}

function parseNotificationFocus(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value : null;
}

function buildNotificationReturnHref(
  from: string | null,
  filter: NotificationFilter,
  cursor: string | null,
  focus: string | null,
): string | null {
  if (from !== "notifications") return null;
  const params = new URLSearchParams({ view: filter });
  if (cursor !== null) params.set("cursor", cursor);
  if (focus !== null) params.set("focus", focus);
  return `/notifications?${params.toString()}`;
}

async function responseError(response: Response, fallback: string) {
  return (await safeResponseError(response, fallback)).message;
}

function intervalLabel(value: number) {
  if (value % 1440 === 0) return `每 ${value / 1440} 天`;
  if (value % 60 === 0) return `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}

function automationPayer(rule: AutomationRule): string {
  return rule.kind === "memoryIndex" || rule.kind === "projectBrief"
    ? "AI 工作台当次确认后决定"
    : "不产生模型费用";
}

function automationSuccessEvidence(rule: AutomationRule): string {
  const latestSuccessfulRun = rule.runs.find((run) => run.status === "succeeded" && run.completedAt !== null);
  return latestSuccessfulRun?.completedAt === undefined || latestSuccessfulRun.completedAt === null
    ? "尚未取得成功运行证据"
    : `最近成功运行：${formatDateTime(new Date(latestSuccessfulRun.completedAt))}`;
}

export function ProjectAutomationsClient({ username, projectId }: { username: string; projectId: string }) {
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("automations", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const runQuery = navigation.run;
  const notificationFilter = parseNotificationFilter(navigation.view);
  const notificationCursor = parseNotificationCursor(navigation.cursor);
  const notificationFocus = parseNotificationFocus(navigation.focus);
  const notificationReturnHref = navigation.returnTo ?? buildNotificationReturnHref(navigation.from, notificationFilter, notificationCursor, notificationFocus);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [capabilities, setCapabilities] = useState<AutomationCapabilities | null>(null);
  const [focusedRun, setFocusedRun] = useState<AutomationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const query = runQuery === null ? "" : `?run=${encodeURIComponent(runQuery)}`;
      const response = await fetch(`/api/projects/${projectId}/automations${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "自动化规则加载失败"));
      const payload = await response.json() as { rules: AutomationRule[]; capabilities?: AutomationCapabilities; run?: AutomationRun | null };
      setRules(payload.rules);
      setCapabilities(payload.capabilities ?? readOnlyCapabilities);
      setFocusedRun(payload.run ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "自动化规则加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId, runQuery]);

  useEffect(() => { const timer = window.setTimeout(() => void reload({ showLoading: true }), 0); return () => window.clearTimeout(timer); }, [reload]);

  useEffect(() => {
    if (focusedRun === null) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`automation-run-${focusedRun.id}`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusedRun]);

  const effectiveCapabilities = capabilities ?? readOnlyCapabilities;

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="automations" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Persistent worker</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目自动化</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">规则和运行记录保存在数据库，由独立 Worker 领取并带租约执行。网页来源刷新与本地治理任务可自动完成；Git 自动化尚未开放。向模型发送内容的任务只会准备边界并通知你确认，不会静默外传。</p>
        </section>
        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <div className="mt-8 grid gap-7 xl:grid-cols-[.75fr_1.25fr]">
          {effectiveCapabilities.canCreate ? <AutomationForm projectId={projectId} onCreated={(rule) => setRules((current) => [...current, rule])} /> : <section className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">只读访问</p><h2 className="mt-2 text-2xl font-semibold">自动化由项目 Owner 管理</h2><p className="mt-4 text-sm leading-6 text-slate-600">你当前是{effectiveCapabilities.permission === "edit" ? " Editor" : " Viewer"}。可以查看规则、运行时间和失败建议，但创建、启用、暂停与立即运行仅对项目 Owner 开放。</p></section>}
          <section><div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Rules</p><h2 className="mt-2 text-2xl font-semibold">运行规则</h2></div><span className="text-xs text-slate-400">{loading ? "读取中…" : `${rules.length} 条`}</span></div>{focusedRun ? <AutomationRunDetail projectId={projectId} run={focusedRun} returnHref={notificationReturnHref} /> : null}<div className="space-y-4">{!loading && rules.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">还没有可运行的自动化规则。Git 自动化尚未开放；可先预览网页来源、记忆质量或项目计划提醒。</div> : rules.map((rule) => <AutomationCard key={rule.id} projectId={projectId} rule={rule} capabilities={effectiveCapabilities} focusedRunId={focusedRun?.id ?? runQuery} onReload={reload} />)}</div></section>
        </div>
      </div>
    </main>
  );
}

function AutomationForm({ projectId, onCreated }: { projectId: string; onCreated: (rule: AutomationRule) => void }) {
  const [name, setName] = useState("每日记忆质量检查");
  const [kind, setKind] = useState<RuleKind>("memoryQuality");
  const [intervalMinutes, setIntervalMinutes] = useState("1440");
  const [dueSoonDays, setDueSoonDays] = useState("3");
  const [includeAssignees, setIncludeAssignees] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  function invalidatePreview() {
    if (preview !== null) setPreview(null);
  }

  function chooseKind(value: RuleKind) {
    setKind(value); invalidatePreview();
    setName(value === "repositorySync" ? "每日代码仓库同步" : value === "memoryQuality" ? "每日记忆质量检查" : value === "memoryIndex" ? "增量记忆索引提醒" : value === "projectBrief" ? "项目简报提醒" : value === "projectPlanHealth" ? "每日项目计划健康提醒" : "网页来源刷新");
  }

  function config() {
    return kind === "repositorySync" ? { linkIds: [] } : kind === "memoryIndex" ? { mode: "incremental" } : kind === "projectPlanHealth" ? { dueSoonDays: Number(dueSoonDays), includeAssignees } : {};
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const response = await fetch(`/api/projects/${projectId}/automations/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, kind, intervalMinutes: Number(intervalMinutes), config: config(), browserTimeZone }) });
      if (!response.ok) throw new Error(await responseError(response, "自动化预览失败"));
      setPreview((await response.json() as { preview: AutomationPreview }).preview);
      setMessage("影响预览已生成，请确认后保存规则。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "自动化预览失败"); }
    finally { setPending(false); }
  }

  async function confirm() {
    if (preview === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/automations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: preview.canonicalPayload.name, kind: preview.canonicalPayload.kind, intervalMinutes: preview.canonicalPayload.intervalMinutes, config: preview.canonicalPayload.config, startAt: preview.canonicalPayload.startAtUtc, expectedPreviewFingerprint: preview.previewFingerprint, previewPayload: preview.canonicalPayload }) });
      if (!response.ok) throw new Error(await responseError(response, "自动化规则创建失败"));
      const rule = (await response.json() as { rule: AutomationRule }).rule;
      onCreated(rule); setPreview(null); setMessage("规则已保存，Worker 会在首次运行时间领取任务。");
      confirmButtonRef.current?.focus();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "自动化规则创建失败"); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New rule</p><h2 className="mt-2 text-2xl font-semibold">添加自动化</h2><Field label="任务类型"><select value={kind} onChange={(event) => chooseKind(event.target.value as RuleKind)} className="field"><option value="repositorySync" disabled>代码仓库同步（尚未开放）</option>{Object.entries(kindLabels).filter(([value]) => value !== "repositorySync").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="规则名称"><input value={name} onChange={(event) => { setName(event.target.value); invalidatePreview(); }} className="field" required /></Field><Field label="执行间隔"><select value={intervalMinutes} onChange={(event) => { setIntervalMinutes(event.target.value); invalidatePreview(); }} className="field"><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option><option value="10080">每周</option></select></Field>{kind === "projectPlanHealth" ? <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 p-4"><Field label="即将到期窗口"><select value={dueSoonDays} onChange={(event) => { setDueSoonDays(event.target.value); invalidatePreview(); }} className="field"><option value="1">1 天</option><option value="3">3 天</option><option value="7">7 天</option><option value="14">14 天</option></select></Field><label className="mt-4 flex items-center gap-3 text-sm text-slate-700"><input type="checkbox" checked={includeAssignees} onChange={(event) => { setIncludeAssignees(event.target.checked); invalidatePreview(); }} />同时提醒相关负责人</label><p className="mt-3 text-xs leading-5 text-indigo-700">此检查只读取本地计划、审批和证据状态，不调用模型，也不发送项目内容到外部服务。</p></div> : null}{kind === "memoryIndex" || kind === "projectBrief" ? <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">此任务只创建 waitingConsent 通知：不选模型、不扣费、不发送项目内容；真实付费方仅在你到 AI 工作台当次确认后解析。</p> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<button ref={confirmButtonRef} type="submit" disabled={pending} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending ? "预览中…" : "预览并确认"}</button>{preview ? <AutomationPreviewPanel preview={preview} pending={pending} onCancel={() => { setPreview(null); setMessage(null); confirmButtonRef.current?.focus(); }} onConfirm={() => void confirm()} /> : null}<style jsx>{`.field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid #cbd5e1;background:white;padding:.72rem .9rem;font-size:.875rem;color:#0f172a;outline:none}.field:focus{border-color:#818cf8;box-shadow:0 0 0 3px rgba(129,140,248,.14)}`}</style></form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}{children}</label>; }

function AutomationPreviewPanel({ preview, pending, onCancel, onConfirm }: { preview: AutomationPreview; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const notification = preview.scope.notification;
  const notificationLabel = notification.condition === "onFailure"
    ? `仅失败时通知创建者（${notification.count} 人）`
    : notification.condition === "waitingConsent"
      ? `生成待确认通知给创建者（${notification.count} 人）`
      : notification.audience === "creatorAndEligibleAssignees"
        ? `通知规则创建者及合格负责人（${notification.count} 人）`
        : `通知创建者（${notification.count} 人）`;
  const delivery = preview.scope.requiresConfirmation ? "仅创建 waitingConsent 通知，不发送项目内容" : preview.scope.delivery === "localNotification" ? "仅在平台通知中心提醒" : "需要 AI 工作台当次确认";
  const connectionOwner = preview.requiresConfirmation ? "本次不使用连接；后续由 AI 工作台当次解析" : "不使用模型或个人连接";
  return <section aria-labelledby="automation-preview-title" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5"><h3 id="automation-preview-title" className="text-base font-semibold text-indigo-950">创建前影响预览</h3><dl className="mt-4 grid gap-3 text-xs text-indigo-950 sm:grid-cols-2"><div><dt className="text-indigo-700">下一次预计运行（UTC）</dt><dd className="mt-1 font-semibold">{preview.firstRunAtUtc}</dd></div><div><dt className="text-indigo-700">下一次预计运行（浏览器时间）</dt><dd className="mt-1 font-semibold">{preview.firstRunAtBrowserTime} · {preview.browserTimeZone}</dd></div><div><dt className="text-indigo-700">执行间隔</dt><dd className="mt-1 font-semibold">{intervalLabel(preview.intervalMinutes)}</dd></div><div><dt className="text-indigo-700">失败策略</dt><dd className="mt-1 font-semibold">业务执行失败不会在当前周期内自动重试；Worker 租约过期会按恢复策略安排后续运行；连续失败 3 次后自动暂停规则</dd></div><div><dt className="text-indigo-700">作用范围</dt><dd className="mt-1 font-semibold">{preview.scope.label}</dd></div><div><dt className="text-indigo-700">通知范围与条件</dt><dd className="mt-1 font-semibold">{notificationLabel}</dd></div><div><dt className="text-indigo-700">模型外发</dt><dd className="mt-1 font-semibold">否</dd></div></dl>{preview.scope.sourceCount > 0 ? <p className="mt-4 text-xs leading-5 text-indigo-800">来源数量：{preview.scope.sourceCount}{preview.scope.safeDomains.length > 0 ? ` · 安全域名：${preview.scope.safeDomains.join("、")}` : ""}</p> : null}<div className="mt-4"><ScopeEvidenceCard title="本次自动化边界" evidence={{ scope: preview.scope.label, owner: connectionOwner, payer: preview.billing === "none" || preview.billing === "不适用" ? "不产生模型费用" : preview.billing, affectedProjects: "仅当前项目", latestSuccess: "创建前预览；尚无运行记录" }} /></div><p className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-900">{delivery}{preview.requiresConfirmation ? "。不选模型、不扣费；真实付费方仅在 AI 工作台当次确认后解析。" : "。"}</p><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={onCancel} disabled={pending} className="rounded-xl border border-indigo-200 bg-white px-4 py-2 text-xs font-semibold text-indigo-800 disabled:opacity-50">返回修改</button><button type="button" onClick={onConfirm} disabled={pending} className="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-600 disabled:opacity-50">{pending ? "保存中…" : "确认创建"}</button></div></section>;
}

const healthCountLabels: Record<string, string> = {
  active: "活动工作项",
  overdue: "逾期",
  dueSoon: "即将到期",
  blocked: "受阻",
  dependencyBlocked: "依赖阻塞",
  unassigned: "未分配",
  missingAcceptance: "缺少验收标准",
  missingEvidence: "缺少证据",
  staleEvidence: "过期证据",
  pendingRecommendations: "待处理建议",
  openImpacts: "待评估变更",
  pendingApprovals: "待审批",
};

function AutomationRunResultView({ result }: { result: AutomationRunResult | null }) {
  if (result === null) return <p className="mt-4 text-xs text-indigo-800">没有可展示的运行结果。</p>;
  if (result.availability === "unavailable") return <p className="mt-4 text-xs text-indigo-800">运行结果不可用，系统未展示原始数据。</p>;
  if (result.kind === "waitingConsent") return <p className="mt-4 text-xs leading-5 text-indigo-800">仅生成待确认通知：不选模型、不扣费、不发送项目内容。</p>;
  if (result.kind === "webSourceSync") return <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-950"><p>成功来源：{result.successCount ?? 0} · 失败来源：{result.failedCount ?? 0}</p>{(result.failures?.length ?? 0) > 0 ? <p className="mt-1">失败摘要：{result.failures?.map((failure) => failure.failureCode).join("、")}</p> : null}</div>;
  if (result.kind === "memoryQuality") return <p className="mt-4 text-xs leading-5 text-indigo-800">质量评分：{result.score ?? "不可用"} · 待处理问题：{result.openIssueCount ?? "不可用"}</p>;
  if (result.kind === "projectPlanHealth") return <div className="mt-4 grid gap-2 text-xs text-indigo-800 sm:grid-cols-3">{Object.entries(healthCountLabels).map(([key, label]) => <span key={key}>{label}：{result.counts?.[key] ?? "不可用"}</span>)}</div>;
  return <p className="mt-4 text-xs text-indigo-800">运行结果已完成。</p>;
}

function AutomationRunDetail({ projectId, run, returnHref }: { projectId: string; run: AutomationRun; returnHref: string | null }) {
  const failure = run.status === "failed" ? automationFailurePresentation(run.failureCode) : null;
  return <section id={`automation-run-${run.id}`} tabIndex={-1} aria-labelledby={`automation-run-title-${run.id}`} className="mb-5 scroll-mt-28 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 outline-none focus:ring-4 focus:ring-indigo-100"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">运行详情</p><h3 id={`automation-run-title-${run.id}`} className="mt-2 text-base font-semibold text-indigo-950">{run.rule?.name ?? "自动化运行"}</h3></div><span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-800">{runStatusLabels[run.status] ?? run.status}</span></div><p className="mt-3 text-xs text-indigo-800">计划时间：{new Date(run.scheduledFor).toISOString()} · 浏览器时间：{new Date(run.scheduledFor).toLocaleString("zh-CN")} · 仅用于本次查看</p>{failure ? <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-950"><p className="font-semibold">{failure.title}</p><p className="mt-1">{failure.reason}</p><p className="mt-1">下一步：{failure.nextStep}</p><p className="mt-1 font-mono text-[12px]">错误代码：{failure.code ?? "AUTOMATION_EXECUTION_FAILED"}</p></div> : <p className="mt-4 text-xs text-indigo-800">该运行没有失败建议。</p>}<AutomationRunResultView result={run.result} /><div className="mt-4 flex flex-wrap gap-2">{returnHref ? <Link href={returnHref} className="inline-flex rounded-xl bg-indigo-700 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-600">返回活动记录</Link> : null}<a href={buildProjectHref(projectId, "automations", { run: run.id })} className="inline-flex rounded-xl border border-indigo-200 bg-white px-4 py-2 text-xs font-semibold text-indigo-800">保留此运行上下文</a></div></section>;
}

function AutomationCard({ projectId, rule, capabilities, focusedRunId, onReload }: { projectId: string; rule: AutomationRule; capabilities: AutomationCapabilities; focusedRunId: string | null; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null); const latest = rule.runs[0];
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "规则更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "规则更新失败"); } finally { setPending(false); } }
  async function runNow() { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}/run`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response, "立即运行失败")); setMessage("已排到 Worker 队列，完成结果会进入通知中心。"); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "立即运行失败"); } finally { setPending(false); } }
  const frozen = rule.kind === "repositorySync";
  const failure = latest?.failureCode ? automationFailurePresentation(latest.failureCode) : null;
  const highlighted = latest?.id === focusedRunId;
  return <article className={`rounded-3xl border bg-white p-6 shadow-sm outline-none ${highlighted ? "border-indigo-400 ring-4 ring-indigo-100" : "border-slate-200"}`} tabIndex={highlighted ? -1 : undefined}><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{rule.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${frozen ? "bg-amber-50 text-amber-700" : rule.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{frozen ? "自动化已冻结" : rule.status === "active" ? "运行中" : "已暂停"}</span></div><p className="mt-2 text-xs text-slate-500">{kindLabels[rule.kind]} · {intervalLabel(rule.intervalMinutes)}</p></div><p className="text-xs text-slate-400">连续失败 {rule.consecutiveFailures} 次</p></div><div className="mt-5 grid gap-3 sm:grid-cols-3"><Info label="下次运行" value={formatDateTime(new Date(rule.nextRunAt))} /><Info label="最近运行" value={rule.lastRunAt ? formatDateTime(new Date(rule.lastRunAt)) : "尚未运行"} /><Info label="最近结果" value={latest?.status ? runStatusLabels[latest.status] ?? latest.status : "—"} /></div><div className="mt-5"><ScopeEvidenceCard title="已保存规则边界" evidence={{ scope: `仅当前项目 · ${kindLabels[rule.kind]}`, owner: "当前项目 Owner", payer: automationPayer(rule), affectedProjects: "仅当前项目", latestSuccess: automationSuccessEvidence(rule) }} /></div>{failure ? <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-800"><p className="font-semibold">{failure.title}</p><p>{failure.reason}</p><p>下一步：{failure.nextStep}</p><p className="mt-1 font-mono text-[12px]">错误代码：{failure.code ?? "AUTOMATION_EXECUTION_FAILED"}</p></div> : null}<div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs text-slate-600">{message ?? (frozen ? "Git 自动化尚未开放；历史规则会在 Worker 领取前安全暂停。" : rule.kind === "memoryIndex" || rule.kind === "projectBrief" ? "只创建 waitingConsent 通知，不选模型、不扣费、不发送项目内容。" : "运行记录和租约均持久化。")}</p>{capabilities.canManage && !frozen ? <div className="flex gap-2">{rule.status === "active" ? <button type="button" onClick={() => void patch({ enabled: false })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">暂停</button> : <button type="button" onClick={() => void patch({ enabled: true })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">启用</button>}{capabilities.canRunNow && rule.status === "active" ? <button type="button" onClick={() => void runNow()} disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">立即运行</button> : null}</div> : null}</div></article>;
}

function formatDateTime(value: Date) { return `${value.toLocaleString("zh-CN")} · ${Intl.DateTimeFormat().resolvedOptions().timeZone || "浏览器时区"}`; }

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-slate-50 px-4 py-3"><span className="block text-[12px] text-slate-400">{label}</span><strong className="mt-1 block truncate text-xs font-semibold text-slate-700">{value}</strong></div>; }
