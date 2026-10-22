"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";

import formFields from "@/components/model-form-fields.module.css";

import {  UiText, useTranslate } from "@/components/appearance-provider";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { OperationPanel } from "@/components/operation-panel";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { TokenUsageView } from "@/components/token-usage";
import { automationFailurePresentation } from "@/lib/automation-failure-presentation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { TokenUsageSummary } from "@/lib/token-usage";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import styles from "./project-automations-client.module.css";

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
type AutomationRun = { id: string; automationRuleId?: string; projectId?: string; status: string; scheduledFor: string; failureCode: string | null; completedAt: string | null; createdAt?: string; jobIds?: string[]; result: AutomationRunResult | null; usage?: TokenUsageSummary; rule?: { name: string; kind: RuleKind } };
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

function intervalLabel(value: number, t: (text: string) => string) {
  if (value % 1440 === 0) return t("每 {count} 天").replace("{count}", String(value / 1440));
  if (value % 60 === 0) return t("每 {count} 小时").replace("{count}", String(value / 60));
  return t("每 {count} 分钟").replace("{count}", String(value));
}

function automationPayer(rule: AutomationRule): string {
  return rule.kind === "memoryIndex" || rule.kind === "projectBrief"
    ? "AI 工作台当次确认后决定"
    : "不产生模型费用";
}

function automationSuccessEvidence(rule: AutomationRule, t: (text: string) => string): string {
  const latestSuccessfulRun = rule.runs.find((run) => run.status === "succeeded" && run.completedAt !== null);
  return latestSuccessfulRun?.completedAt === undefined || latestSuccessfulRun.completedAt === null
    ? t("尚未取得成功运行证据")
    : t("最近成功运行：{time}").replace("{time}", formatDateTime(new Date(latestSuccessfulRun.completedAt)));
}

export function ProjectAutomationsClient(props: { username: string; projectId: string; isSystemAdmin: boolean }) {
  return <ProjectAutomationsWorkspace key={props.projectId} {...props} />;
}

function ProjectAutomationsWorkspace({ username, projectId, isSystemAdmin }: { username: string; projectId: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
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
  const [createOpen, setCreateOpen] = useState(false);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const loadRequestIdRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && loadRequestIdRef.current === requestId;
    if (showLoading) setLoading(true);
    try {
      const query = runQuery === null ? "" : `?run=${encodeURIComponent(runQuery)}`;
      const response = await fetch(`/api/projects/${projectId}/automations${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "自动化规则加载失败"));
      const payload = await response.json() as { rules: AutomationRule[]; capabilities?: AutomationCapabilities; run?: AutomationRun | null };
      if (!isCurrentRequest()) return;
      setRules(payload.rules);
      setCapabilities(payload.capabilities ?? readOnlyCapabilities);
      setFocusedRun(payload.run ?? null);
      setError(null);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setError(cause instanceof Error ? cause.message : "自动化规则加载失败");
    } finally {
      if (isCurrentRequest()) {
        loadControllerRef.current = null;
        if (showLoading) setLoading(false);
      }
    }
  }, [projectId, runQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestIdRef.current += 1;
      loadControllerRef.current?.abort();
    };
  }, [reload]);

  useEffect(() => () => loadControllerRef.current?.abort(), []);

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
  const recentRuns = useMemo(() => rules
    .flatMap((rule) => rule.runs.map((run) => ({ rule, run })))
    .sort((left, right) => new Date(right.run.createdAt ?? right.run.scheduledFor).getTime() - new Date(left.run.createdAt ?? left.run.scheduledFor).getTime()), [rules]);
  const runHref = (runId: string) => buildProjectHref(projectId, "automations", {
    run: runId,
    from: navigation.from,
    view: navigation.view,
    cursor: navigation.cursor,
    focus: navigation.focus,
    returnTo: navigation.returnTo,
  });

  return (
    <main className={styles.page}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="automations" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className={styles.content}>
        <header className={styles.pageHeader}>
          <div><h1 className="text-2xl font-semibold tracking-tight text-slate-950"><UiText text={"项目自动化"} /></h1><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600"><UiText text={"查看规则、最近运行和异常，所有规则变更都需要明确操作。"} /></p></div>
          <div className="flex flex-wrap gap-2"><OperationPanel title="自动化运行记录" triggerLabel="运行记录" description="当前项目每条规则最近 5 条运行记录；这里只展示已由服务端加载的运行实例。" open={runHistoryOpen} onOpenChange={setRunHistoryOpen} variant="drawer"><section aria-labelledby="automation-run-history-title"><h3 id="automation-run-history-title" className="text-base font-semibold text-slate-900"><UiText text="跨规则运行记录" /></h3><p className="mt-2 text-sm leading-6 text-slate-500"><UiText text="按运行时间排列当前项目各规则的已加载记录。每条规则最多展示最近 5 条，不代表完整历史。" /></p>{loading ? <p role="status" className="mt-6 text-sm text-slate-500"><UiText text="正在读取自动化运行记录…" /></p> : recentRuns.length === 0 ? <p className="mt-6 rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500"><UiText text="当前没有已加载的自动化运行记录。" /></p> : <ul className="mt-5 divide-y divide-slate-200">{recentRuns.map(({ rule, run }) => <li key={run.id} className="py-4"><Link href={runHref(run.id)} onClick={() => setRunHistoryOpen(false)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"><span className="min-w-0"><strong className="block truncate text-sm font-semibold text-slate-900">{rule.name}</strong><span className="mt-1 block text-xs text-slate-500"><UiText text="来源规则" /> · {translateUi(kindLabels[rule.kind])} · {formatDateTime(new Date(run.createdAt ?? run.scheduledFor))}</span></span><span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{translateUi(runStatusLabels[run.status] ?? "未知状态")}</span></Link></li>)}</ul>}</section></OperationPanel><Link className={styles.headerLink} href={`/projects/${encodeURIComponent(projectId)}/intelligence`}><UiText text={"项目简报与调查"} /></Link><Link className={styles.headerLink} href={`/projects/${encodeURIComponent(projectId)}/configuration`}><UiText text={"配置 AI 路由"} /></Link></div>
        </header>
        <p className={styles.safetyNote}><UiText text={"模型相关规则只生成待确认通知；实际外发仍需在 AI 工作台逐次确认。"} /></p>
        {error ? <div role="alert" className={styles.errorNotice}><UiErrorText text={error} /></div> : null}
        <div className={styles.workspace}>
          {effectiveCapabilities.canCreate ? <OperationPanel title={translateUi("添加自动化")} triggerLabel="添加自动化" open={createOpen} onOpenChange={setCreateOpen} variant="drawer" description="先预览规则影响范围，再确认保存。保存后由 Worker 在预计时间领取任务。"><AutomationForm projectId={projectId} onCreated={(rule) => { setRules((current) => [...current, rule]); setCreateOpen(false); }} /></OperationPanel> : <p className={styles.permissionNote}><UiText text={"自动化由项目 Owner 管理。你当前是"} />{effectiveCapabilities.permission === "edit" ? " Editor" : " Viewer"}<UiText text={"，可以查看规则、运行时间和失败建议。"} /></p>}
          <section aria-labelledby="automation-rules-heading">
            <div className={styles.listHeading}><h2 id="automation-rules-heading" className="text-base font-semibold text-slate-900"><UiText text={"运行规则"} /></h2><span className="text-xs text-slate-400">{loading ? <UiText text={"读取中…"} /> : error ? <UiText text={"读取失败"} /> : `${rules.length} 条`}</span></div>
            {focusedRun ? <AutomationRunDetail projectId={projectId} run={focusedRun} returnHref={notificationReturnHref} /> : null}
            {loading ? <div className={styles.loadingRow} aria-label={translateUi("正在读取自动化规则")} /> : error ? null : rules.length === 0 ? <div className={styles.emptyState}><UiText text={"还没有自动化规则。选择“添加自动化”查看当前项目可用的规则和影响范围。"} /></div> : <div className={styles.ruleList}>{rules.map((rule) => <AutomationCard key={`${projectId}:${rule.id}`} projectId={projectId} rule={rule} capabilities={effectiveCapabilities} focusedRunId={focusedRun?.id ?? runQuery} onReload={reload} runHref={runHref} />)}</div>}
          </section>
        </div>
      </div>
    </main>
  );
}

function AutomationForm({ projectId, onCreated }: { projectId: string; onCreated: (rule: AutomationRule) => void }) {
  const translateUi = useTranslate();
  const [name, setName] = useState(() => translateUi("每日记忆质量检查"));
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
    setName(translateUi(value === "repositorySync" ? "每日代码仓库同步" : value === "memoryQuality" ? "每日记忆质量检查" : value === "memoryIndex" ? "增量记忆索引提醒" : value === "projectBrief" ? "项目简报提醒" : value === "projectPlanHealth" ? "每日项目计划健康提醒" : "网页来源刷新"));
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

  return <form onSubmit={submit}><Field label={translateUi("任务类型")}><select value={kind} onChange={(event) => chooseKind(event.target.value as RuleKind)} className={`${formFields.field} field`}><option value="repositorySync" disabled><UiText text={"代码仓库同步（尚未开放）"} /></option>{Object.entries(kindLabels).filter(([value]) => value !== "repositorySync").map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></Field><Field label={translateUi("规则名称")}><input value={name} onChange={(event) => { setName(event.target.value); invalidatePreview(); }} className={`${formFields.field} field`} required /></Field><Field label={translateUi("执行间隔")}><select value={intervalMinutes} onChange={(event) => { setIntervalMinutes(event.target.value); invalidatePreview(); }} className={`${formFields.field} field`}><option value="60"><UiText text={"每小时"} /></option><option value="360"><UiText text={"每 6 小时"} /></option><option value="720"><UiText text={"每 12 小时"} /></option><option value="1440"><UiText text={"每天"} /></option><option value="10080"><UiText text={"每周"} /></option></select></Field>{kind === "projectPlanHealth" ? <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 p-4"><Field label={translateUi("即将到期窗口")}><select value={dueSoonDays} onChange={(event) => { setDueSoonDays(event.target.value); invalidatePreview(); }} className={`${formFields.field} field`}><option value="1"><UiText text={"1 天"} /></option><option value="3"><UiText text={"3 天"} /></option><option value="7"><UiText text={"7 天"} /></option><option value="14"><UiText text={"14 天"} /></option></select></Field><label className="mt-4 flex items-center gap-3 text-sm text-slate-700"><input type="checkbox" checked={includeAssignees} onChange={(event) => { setIncludeAssignees(event.target.checked); invalidatePreview(); }} /><UiText text={"同时提醒相关负责人"} /></label><p className="mt-3 text-xs leading-5 text-indigo-700"><UiText text={"此检查只读取本地计划、审批和证据状态，不调用模型，也不发送项目内容到外部服务。"} /></p></div> : null}{kind === "memoryIndex" || kind === "projectBrief" ? <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700"><UiText text={"此任务只创建 waitingConsent 通知：不选模型、不扣费、不发送项目内容；真实付费方仅在你到 AI 工作台当次确认后解析。"} /></p> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600"><UiFeedbackText text={message} /></p> : null}<button ref={confirmButtonRef} type="submit" disabled={pending} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending ? <UiText text={"预览中…"} /> : <UiText text={"预览并确认"} />}</button>{preview ? <AutomationPreviewPanel preview={preview} pending={pending} onCancel={() => { setPreview(null); setMessage(null); confirmButtonRef.current?.focus(); }} onConfirm={() => void confirm()} /> : null}</form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}{children}</label>; }

function AutomationPreviewPanel({ preview, pending, onCancel, onConfirm }: { preview: AutomationPreview; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const translateUi = useTranslate();
  const notification = preview.scope.notification;
  const notificationLabel = notification.condition === "onFailure"
    ? translateUi("仅失败时通知创建者（{count} 人）").replace("{count}", String(notification.count))
    : notification.condition === "waitingConsent"
      ? translateUi("生成待确认通知给创建者（{count} 人）").replace("{count}", String(notification.count))
      : notification.audience === "creatorAndEligibleAssignees"
        ? translateUi("通知规则创建者及合格负责人（{count} 人）").replace("{count}", String(notification.count))
        : translateUi("通知创建者（{count} 人）").replace("{count}", String(notification.count));
  const delivery = preview.scope.requiresConfirmation ? translateUi("仅创建 waitingConsent 通知，不发送项目内容") : preview.scope.delivery === "localNotification" ? translateUi("仅在平台通知中心提醒") : translateUi("需要 AI 工作台当次确认");
  const connectionOwner = preview.requiresConfirmation ? translateUi("本次不使用连接；后续由 AI 工作台当次解析") : translateUi("不使用模型或个人连接");
  return <section aria-labelledby="automation-preview-title" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5"><h3 id="automation-preview-title" className="text-base font-semibold text-indigo-950"><UiText text={"创建前影响预览"} /></h3><dl className="mt-4 grid gap-3 text-xs text-indigo-950 sm:grid-cols-2"><div><dt className="text-indigo-700"><UiText text={"下一次预计运行（UTC）"} /></dt><dd className="mt-1 font-semibold">{preview.firstRunAtUtc}</dd></div><div><dt className="text-indigo-700"><UiText text={"下一次预计运行（浏览器时间）"} /></dt><dd className="mt-1 font-semibold">{preview.firstRunAtBrowserTime} · {preview.browserTimeZone}</dd></div><div><dt className="text-indigo-700"><UiText text={"执行间隔"} /></dt><dd className="mt-1 font-semibold">{intervalLabel(preview.intervalMinutes, translateUi)}</dd></div><div><dt className="text-indigo-700"><UiText text={"失败策略"} /></dt><dd className="mt-1 font-semibold"><UiText text={"业务执行失败不会在当前周期内自动重试；Worker 租约过期会按恢复策略安排后续运行；连续失败 3 次后自动暂停规则"} /></dd></div><div><dt className="text-indigo-700"><UiText text={"作用范围"} /></dt><dd className="mt-1 font-semibold">{translateUi(preview.scope.label)}</dd></div><div><dt className="text-indigo-700"><UiText text={"通知范围与条件"} /></dt><dd className="mt-1 font-semibold">{notificationLabel}</dd></div><div><dt className="text-indigo-700"><UiText text={"模型外发"} /></dt><dd className="mt-1 font-semibold"><UiText text={"否"} /></dd></div></dl>{preview.scope.sourceCount > 0 ? <p className="mt-4 text-xs leading-5 text-indigo-800"><UiText text={"来源数量："} />{preview.scope.sourceCount}{preview.scope.safeDomains.length > 0 ? ` · 安全域名：${preview.scope.safeDomains.join("、")}` : ""}</p> : null}<div className="mt-4"><ScopeEvidenceCard title={translateUi("本次自动化边界")} evidence={{ scope: translateUi(preview.scope.label), owner: connectionOwner, payer: preview.billing === "none" || preview.billing === "不适用" ? translateUi("不产生模型费用") : translateUi(preview.billing), affectedProjects: translateUi("仅当前项目"), latestSuccess: translateUi("创建前预览；尚无运行记录") }} /></div><p className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-900">{delivery}{preview.requiresConfirmation ? <UiText text={"。不选模型、不扣费；真实付费方仅在 AI 工作台当次确认后解析。"} /> : "。"}</p><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={onCancel} disabled={pending} className="rounded-xl border border-indigo-200 bg-white px-4 py-2 text-xs font-semibold text-indigo-800 disabled:opacity-50"><UiText text={"返回修改"} /></button><button type="button" onClick={onConfirm} disabled={pending} className="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-600 disabled:opacity-50">{pending ? <UiText text={"保存中…"} /> : <UiText text={"确认创建"} />}</button></div></section>;
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
  const translateUi = useTranslate();
  if (result === null) return <p className="mt-4 text-xs text-indigo-800"><UiText text={"没有可展示的运行结果。"} /></p>;
  if (result.availability === "unavailable") return <p className="mt-4 text-xs text-indigo-800"><UiText text={"运行结果不可用，系统未展示原始数据。"} /></p>;
  if (result.kind === "waitingConsent") return <p className="mt-4 text-xs leading-5 text-indigo-800"><UiText text={"仅生成待确认通知：不选模型、不扣费、不发送项目内容。"} /></p>;
  if (result.kind === "webSourceSync") return <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-950"><p><UiText text={"成功来源："} />{result.successCount ?? 0} {" "}<UiText text={"· 失败来源："} />{result.failedCount ?? 0}</p>{(result.failures?.length ?? 0) > 0 ? <p className="mt-1"><UiText text={"失败摘要："} />{result.failures?.map((failure) => failure.failureCode).join("、")}</p> : null}</div>;
  if (result.kind === "memoryQuality") return <p className="mt-4 text-xs leading-5 text-indigo-800"><UiText text={"质量评分："} />{result.score ?? <UiText text={"不可用"} />} {" "}<UiText text={"· 待处理问题："} />{result.openIssueCount ?? <UiText text={"不可用"} />}</p>;
  if (result.kind === "projectPlanHealth") return <div className="mt-4 grid gap-2 text-xs text-indigo-800 sm:grid-cols-3">{Object.entries(healthCountLabels).map(([key, label]) => <span key={key}>{translateUi(label)}：{result.counts?.[key] ?? <UiText text={"不可用"} />}</span>)}</div>;
  return <p className="mt-4 text-xs text-indigo-800"><UiText text={"运行结果已完成。"} /></p>;
}

function AutomationRunDetail({ projectId, run, returnHref }: { projectId: string; run: AutomationRun; returnHref: string | null }) {
  const translateUi = useTranslate();
  const failure = run.status === "failed" ? automationFailurePresentation(run.failureCode) : null;
  return <section id={`automation-run-${run.id}`} tabIndex={-1} aria-labelledby={`automation-run-title-${run.id}`} className={`${styles.runDetail} outline-none focus:ring-4 focus:ring-indigo-100`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold text-indigo-700"><UiText text={"运行详情"} /></p><h3 id={`automation-run-title-${run.id}`} className="mt-1 text-base font-semibold text-indigo-950">{run.rule?.name ?? <UiText text={"自动化运行"} />}</h3></div><span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-800">{translateUi(runStatusLabels[run.status] ?? "未知状态")}</span></div><p className="mt-3 text-xs text-indigo-800"><UiText text={"计划时间："} />{new Date(run.scheduledFor).toISOString()} {" "}<UiText text={"· 浏览器时间："} />{new Date(run.scheduledFor).toLocaleString("zh-CN")} {" "}<UiText text={"· 仅用于本次查看"} /></p>{failure ? <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-5 text-indigo-950"><p className="font-semibold">{translateUi(failure.title)}</p><p className="mt-1">{translateUi(failure.reason)}</p><p className="mt-1"><UiText text={"下一步："} />{translateUi(failure.nextStep)}</p><p className="mt-1 font-mono text-[12px]"><UiText text={"错误代码："} />{failure.code ?? "AUTOMATION_EXECUTION_FAILED"}</p></div> : <p className="mt-4 text-xs text-indigo-800"><UiText text={"该运行没有失败建议。"} /></p>}<AutomationRunResultView result={run.result} /><TokenUsageView usage={run.usage} compact /><div className="mt-4 flex flex-wrap gap-2">{returnHref ? <ParentPageLink href={returnHref} label="返回活动记录" /> : null}<a href={buildProjectHref(projectId, "automations", { run: run.id })} className="inline-flex rounded-xl border border-indigo-200 bg-white px-4 py-2 text-xs font-semibold text-indigo-800"><UiText text={"保留此运行上下文"} /></a></div></section>;
}

function AutomationCard({ projectId, rule, capabilities, focusedRunId, onReload, runHref }: { projectId: string; rule: AutomationRule; capabilities: AutomationCapabilities; focusedRunId: string | null; onReload: () => Promise<void>; runHref: (runId: string) => string }) {
  const translateUi = useTranslate();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const latest = rule.runs[0];
  const frozen = rule.kind === "repositorySync";
  const latestFailure = rule.runs.find((run) => run.failureCode !== null);
  const failure = latestFailure?.failureCode ? automationFailurePresentation(latestFailure.failureCode) : null;
  const highlighted = rule.runs.some((run) => run.id === focusedRunId);

  async function patch(body: unknown) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response, "规则更新失败"));
      await onReload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "规则更新失败");
    } finally {
      setPending(false);
    }
  }

  async function runNow() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}/run`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "立即运行失败"));
      setMessage("已排到 Worker 队列，完成结果会进入通知中心。");
      await onReload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "立即运行失败");
    } finally {
      setPending(false);
    }
  }

  return <article className={`${styles.ruleRow} ${highlighted ? styles.ruleRowHighlighted : ""}`} tabIndex={highlighted ? -1 : undefined}>
    <div className={styles.ruleHeading}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold text-slate-900">{rule.name}</h3><span className={frozen ? styles.statusFrozen : rule.status === "active" ? styles.statusActive : styles.statusPaused}>{frozen ? <UiText text={"已冻结"} /> : rule.status === "active" ? <UiText text={"运行中"} /> : <UiText text={"已暂停"} />}</span></div>
        <p className="mt-1 text-xs text-slate-500">{translateUi(kindLabels[rule.kind])} · {intervalLabel(rule.intervalMinutes, translateUi)}</p>
      </div>
      <div className={styles.ruleControls}>
        {capabilities.canManage && !frozen ? <button type="button" onClick={() => void patch({ enabled: rule.status !== "active" })} disabled={pending} aria-pressed={rule.status === "active"} className={styles.toggleButton}>{pending ? <UiText text={"保存中…"} /> : rule.status === "active" ? <UiText text={"暂停"} /> : <UiText text={"启用"} />}</button> : null}
        <OperationPanel title={`自动化详情：${rule.name}`} triggerLabel="更多" variant="drawer" description="查看规则边界、最近运行、异常与可用操作。">
          <div className={styles.detailPanel}>
            <ScopeEvidenceCard title={translateUi("已保存规则边界")} evidence={{ scope: `${translateUi("仅当前项目")} · ${translateUi(kindLabels[rule.kind])}`, owner: translateUi("当前项目 Owner"), payer: translateUi(automationPayer(rule)), affectedProjects: translateUi("仅当前项目"), latestSuccess: automationSuccessEvidence(rule, translateUi) }} />
            <p role="status" className={styles.detailNote}><UiText text={"下次运行："} />{formatDateTime(new Date(rule.nextRunAt))} · {frozen ? <UiText text={"旧版 Git 规则已冻结；Worker 领取前会安全暂停。"} /> : rule.kind === "memoryIndex" || rule.kind === "projectBrief" ? <UiText text={"只创建 waitingConsent 通知，不选模型、不扣费、不发送项目内容。"} /> : <UiText text={"运行记录和租约均持久化。"} />}</p>
            {failure ? <div className={styles.failureNotice}><p className="font-semibold">{failure.title}</p><p className="mt-1">{failure.reason}</p><p className="mt-1"><UiText text={"下一步："} />{failure.nextStep}</p><p className="mt-1 font-mono"><UiText text={"错误代码："} />{failure.code ?? "AUTOMATION_EXECUTION_FAILED"}</p></div> : null}
            <section className={styles.historySection} aria-labelledby={`automation-history-${rule.id}`}>
              <div className={styles.historyHeading}><h4 id={`automation-history-${rule.id}`}><UiText text={"最近运行记录"} /></h4><span><UiText text={"最多显示 5 条"} /></span></div>
              {rule.runs.length === 0 ? <p className="mt-3 text-xs text-slate-500"><UiText text={"尚无运行记录。"} /></p> : <ul className={styles.historyList}>{rule.runs.map((run) => <li key={run.id}><Link href={runHref(run.id)} className={styles.historyLink}><span>{translateUi(runStatusLabels[run.status] ?? "未知状态")}</span><time dateTime={run.scheduledFor}>{formatDateTime(new Date(run.createdAt ?? run.scheduledFor))}</time><span aria-hidden="true"><UiText text={"查看 →"} /></span></Link></li>)}</ul>}
            </section>
            {capabilities.canManage && !frozen ? <div className={styles.detailActions}>
              {editing ? <AutomationEditForm projectId={projectId} rule={rule} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await onReload(); }} /> : <button type="button" className={styles.toggleButton} onClick={() => setEditing(true)}><UiText text={"编辑规则"} /></button>}
              {capabilities.canRunNow && rule.status === "active" ? <button type="button" onClick={() => void runNow()} disabled={pending} className={styles.runButton}>{pending ? <UiText text={"已提交…"} /> : <UiText text={"立即运行"} />}</button> : null}
              {message ? <p role="alert" className={styles.actionMessage}><UiErrorText text={message} /></p> : null}
            </div> : null}
          </div>
        </OperationPanel>
      </div>
    </div>
    <div className={styles.ruleMeta}>
      <div><span><UiText text={"频率"} /></span><strong>{intervalLabel(rule.intervalMinutes, translateUi)}</strong></div>
      <div><span><UiText text={"上次运行"} /></span><strong>{rule.lastRunAt ? formatDateTime(new Date(rule.lastRunAt)) : <UiText text={"尚未运行"} />}</strong></div>
      <div><span><UiText text={"最近结果"} /></span><strong>{latest?.status ? translateUi(runStatusLabels[latest.status] ?? "未知状态") : "—"}</strong></div>
      <div><span><UiText text={"连续失败"} /></span><strong>{rule.consecutiveFailures} {" "}<UiText text={"次"} /></strong></div>
    </div>
    {message ? <p role="status" className={styles.rowMessage}><UiFeedbackText text={message} /></p> : null}
  </article>;
}

function AutomationEditForm({ projectId, rule, onCancel, onSaved }: { projectId: string; rule: AutomationRule; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(rule.name);
  const [intervalMinutes, setIntervalMinutes] = useState(String(rule.intervalMinutes));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, intervalMinutes: Number(intervalMinutes) }),
      });
      if (!response.ok) throw new Error(await responseError(response, "规则保存失败"));
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "规则保存失败");
    } finally {
      setPending(false);
    }
  }

  return <form className={styles.editForm} onSubmit={(event) => void save(event)}>
    <h4 className="text-sm font-semibold text-slate-900"><UiText text={"编辑规则"} /></h4>
    <label className={styles.editLabel}><UiText text={"名称"} /><input className={styles.editField} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></label>
    <label className={styles.editLabel}><UiText text={"执行频率"} /><select className={styles.editField} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)}><option value="60"><UiText text={"每小时"} /></option><option value="360"><UiText text={"每 6 小时"} /></option><option value="720"><UiText text={"每 12 小时"} /></option><option value="1440"><UiText text={"每天"} /></option><option value="10080"><UiText text={"每周"} /></option></select></label>
    <p className="text-xs leading-5 text-slate-500"><UiText text={"保存时只更新名称和频率；项目范围、通知对象和规则配置保持现有值。"} /></p>
    {error ? <p role="alert" className={styles.actionMessage}><UiErrorText text={error} /></p> : null}
    <div className="flex flex-wrap gap-2"><button type="button" onClick={onCancel} disabled={pending} className={styles.toggleButton}><UiText text={"返回"} /></button><button type="submit" disabled={pending || !name.trim()} className={styles.runButton}>{pending ? <UiText text={"保存中…"} /> : <UiText text={"保存规则"} />}</button></div>
  </form>;
}

function formatDateTime(value: Date) { return `${value.toLocaleString("zh-CN")} · ${Intl.DateTimeFormat().resolvedOptions().timeZone || "浏览器时区"}`; }
