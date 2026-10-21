"use client";

import { UiText, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { OperationPanel } from "@/components/operation-panel";
import { ParentPageLink } from "@/components/parent-page-link";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { parseProjectPageState } from "@/lib/project-navigation";
import { buildProjectQuestionHref } from "../materials/materials-navigation";
import styles from "./project-intelligence-client.module.css";
import type {
  ProjectIntelligenceNextAction,
  ProjectIntelligenceOperationPayer,
  ProjectIntelligenceRouteErrorCode,
  ProjectIntelligenceRouteSource,
  ProjectIntelligenceRuntimeDecision,
} from "@/lib/project-intelligence-runtime-decision";

type Citation = {
  id: string;
  kind: "project" | "item" | "memory" | "repository";
  label: string;
  path: string | null;
  externalRef: string | null;
  frozenCommitSha: string | null;
  contentHash: string;
  excerpt: string;
};

type Observation = { text: string; citations: string[] };
type ReportBody = {
  status: "on_track" | "needs_attention" | "at_risk" | "insufficient_data" | "unknown";
  headline: string;
  summary: string;
  citations: string[];
  progress: Observation[];
  decisions: Observation[];
  issues: Observation[];
  risks: Observation[];
  needsAttention: Observation[];
  questions: Observation[];
};
type Report = {
  id: string;
  report: ReportBody;
  citations: Citation[];
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  inputManifestFingerprint: string;
  createdAt: string;
  providerConnection: { name?: string; kind?: string } | null;
};
type ToolTrace = {
  tool: "project_overview" | "confirmed_items" | "memory_search" | "repository_status";
  arguments: Record<string, unknown>;
  evidenceIds: string[];
  resultCount: number;
};
type AgentRun = {
  id: string;
  question: string;
  answer: string;
  recommendations: Observation[];
  uncertainties: string[];
  citations: Citation[];
  plan: { objective: string; calls: Array<{ tool: ToolTrace["tool"]; arguments: Record<string, unknown> }> };
  trace: ToolTrace[];
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  inputManifestFingerprint: string;
  createdAt: string;
  providerConnection: { name?: string; kind?: string } | null;
};
type ProviderRoute = null | {
  operation: "embedding" | "projectAnalysis";
  modelId: string | null;
  embeddingDimensions?: number | null;
  source: ProjectIntelligenceRouteSource;
  sourceLabel: string;
  payer: ProjectIntelligenceOperationPayer;
  payerLabel: string;
  providerConnection: { name?: string; kind?: string; status?: string } | null;
};
type RouteError = {
  code: ProjectIntelligenceRouteErrorCode;
  source: ProjectIntelligenceRouteSource | null;
};
type Readiness = {
  activeIndex: boolean;
  indexCompatible: boolean;
  state: "routeMissing" | "providerUnavailable" | "indexMissing" | "legacyIndex" | "routeIncompatible" | "inputsChanged" | "ready" | "generationProviderUnavailable";
  embeddingRoute: boolean;
  generationRoute: boolean;
  ready: boolean;
  indexGenerationId: string | null;
  runtimeDecision: ProjectIntelligenceRuntimeDecision;
  routeErrors: { embedding: RouteError | null; generation: RouteError | null };
  routes: { embedding: ProviderRoute; generation: ProviderRoute };
};
type StatusPayload = {
  reports: Report[];
  agentRuns: AgentRun[];
  tools: ToolTrace["tool"][];
  readiness: Readiness;
  runtimeDecision: ProjectIntelligenceRuntimeDecision;
  nextAction: ProjectIntelligenceNextAction;
};

type Confirmation = {
  challengeId: string;
  targetAction: string;
  expiresAt: string;
  safeSummary: Record<string, unknown>;
};
type ApiFailure = { code?: string; message?: string };

const toolLabels: Record<ToolTrace["tool"], string> = {
  project_overview: "项目概览",
  confirmed_items: "已确认条目",
  memory_search: "语义记忆检索",
  repository_status: "仓库状态",
};
const citationKindLabels: Record<Citation["kind"], string> = {
  project: "项目",
  item: "条目",
  memory: "记忆",
  repository: "仓库",
};
const reportSections: Array<{ key: keyof Pick<ReportBody, "progress" | "decisions" | "issues" | "risks" | "needsAttention" | "questions">; label: string }> = [
  { key: "progress", label: "当前进展" },
  { key: "decisions", label: "关键决策" },
  { key: "issues", label: "问题" },
  { key: "risks", label: "风险" },
  { key: "needsAttention", label: "需要关注" },
  { key: "questions", label: "待确认问题" },
];

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

async function readApiFailure(response: Response, fallback: string): Promise<ApiFailure> {
  const failure = await safeResponseError(response, fallback);
  return { code: failure.code ?? undefined, message: failure.message };
}

function confirmationMessage(code: string | undefined): string | null {
  if (code === "WEB_AI_CONFIRMATION_EXPIRED") return "本次确认已过期，请重新读取外发摘要。";
  if (code === "WEB_AI_CONFIRMATION_STALE") return "项目资料、索引或模型路由已变化，请重新读取外发摘要。";
  if (code === "WEB_AI_CONFIRMATION_CONSUMED") return "本次确认已使用，请重新读取外发摘要后再执行。";
  if (code === "WEB_AI_CONFIRMATION_REQUIRED") return "请先读取本次外发摘要，再点击确认并执行。";
  return null;
}

function summaryText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(summaryText).join("、");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${summaryText(entry)}`).join(" · ");
  return "—";
}

function beginFlight(ref: { current: symbol | null }): symbol | null {
  if (ref.current !== null) return null;
  const token = Symbol("web-ai-flight");
  ref.current = token;
  return token;
}

function endFlight(ref: { current: symbol | null }, token: symbol): void {
  if (ref.current === token) ref.current = null;
}

function ConfirmationCard({ confirmation, pending, executeLabel, onExecute }: { confirmation: Confirmation; pending: boolean; executeLabel: string; onExecute: () => void }) {
  const defaultCount = (confirmation.safeSummary.scope as { personalDefaultCount?: unknown } | undefined)?.personalDefaultCount;
  return <div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4" role="status">
    <p className="text-sm font-semibold text-indigo-900"><UiText text={"本次外发摘要"} /></p>
    <p className="mt-2 text-xs leading-5 text-indigo-800"><UiText text={"动作："} />{confirmation.targetAction} {" "}<UiText text={"· 路由："} />{summaryText(confirmation.safeSummary.route)} {" "}<UiText text={"· 范围："} />{summaryText(confirmation.safeSummary.scope)}</p>
    {typeof defaultCount === "number" && defaultCount > 0 ? <p className="mt-2 text-xs leading-5 text-indigo-800"><UiText text={"本次还会发送你标记的"} />{" "}{defaultCount} {" "}<UiText text={"条个人通用记忆；当前项目约定优先。原始文档仍属于个人知识库，但项目成员可查看生成结果，结果可能复述其中内容。"} /></p> : null}
    <p className="mt-2 text-xs text-indigo-700"><UiText text={"确认有效期至"} />{" "}{formatDate(confirmation.expiresAt)}<UiText text={"。摘要不包含原文、问题或指纹。"} /></p>
    <button type="button" onClick={onExecute} disabled={pending} className="mt-4 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? <UiText text={"执行中…"} /> : executeLabel}</button>
  </div>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function ProjectIntelligenceClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  return <ProjectIntelligenceWorkspace key={projectId} projectId={projectId} username={username} isSystemAdmin={isSystemAdmin} />;
}

function ProjectIntelligenceWorkspace({ projectId, username, isSystemAdmin }: { projectId: string; username: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("intelligence", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const [projectName, setProjectName] = useState("项目");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sectionSelection, setSectionSelection] = useState<{ focus: string | null; section: "brief" | "investigation" } | null>(null);
  const activeSection = sectionSelection?.focus === navigation.focus
    ? sectionSelection.section
    : navigation.focus === "agent-investigation" ? "investigation" : "brief";
  const [readinessSelection, setReadinessSelection] = useState<{ focus: string | null; open: boolean } | null>(null);
  const readinessOpen = readinessSelection?.focus === navigation.focus
    ? readinessSelection.open
    : navigation.focus === "runtime-readiness";
  const reloadSequenceRef = useRef(0);
  const reloadControllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    const sequence = ++reloadSequenceRef.current;
    reloadControllerRef.current?.abort();
    const controller = new AbortController();
    reloadControllerRef.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && reloadSequenceRef.current === sequence;
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, statusResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store", signal: controller.signal }),
        fetch(`/api/projects/${projectId}/intelligence/status`, { cache: "no-store", signal: controller.signal }),
      ]);
      if (!isCurrentRequest()) return;
      if (!projectResponse.ok || !statusResponse.ok) {
        const failed = !projectResponse.ok ? projectResponse : statusResponse;
        throw new Error(await readError(failed, "项目智能体加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const intelligencePayload = await statusResponse.json() as StatusPayload;
      setProjectName(projectPayload.project.name);
      setStatus(intelligencePayload);
      setError(null);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setError(loadError instanceof Error ? loadError.message : "项目智能体加载失败");
    } finally {
      if (isCurrentRequest()) {
        reloadControllerRef.current = null;
        if (showLoading) setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      reloadSequenceRef.current += 1;
      reloadControllerRef.current?.abort();
    };
  }, [reload]);

  useEffect(() => () => reloadControllerRef.current?.abort(), []);

  useEffect(() => {
    if (navigation.focus === null || loading || status === null) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(navigation.focus!);
      target?.scrollIntoView({ block: "start" });
      if (target instanceof HTMLElement) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, navigation.focus, status]);

  return (
    <main className={styles.page}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="intelligence" isSystemAdmin={isSystemAdmin} />
      <div className={styles.content}>
        <header className={styles.pageHeader}>
          <div><p className="text-xs font-semibold text-slate-400">{projectName}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950"><UiText text={"简报与调查"} /></h1></div>
          <div className="flex flex-wrap gap-2"><Link href={buildProjectQuestionHref(projectId)} className={styles.headerLink}><UiText text={"智能问答"} /></Link><Link href={`/personal/usage?projectId=${encodeURIComponent(projectId)}`} className={styles.headerLink}><UiText text={"用量记录"} /></Link><Link href={`/projects/${encodeURIComponent(projectId)}/configuration`} className={styles.headerLink}><UiText text={"配置 AI 路由"} /></Link></div>
        </header>

        {navigation.returnTo ? <ParentPageLink href={navigation.returnTo} label="返回来源页面" /> : null}
        {error ? <div role="alert" className={styles.errorNotice}>{error}</div> : null}
        {loading ? <div className={styles.loadingPanel} aria-label={translateUi("正在加载项目简报与调查")} /> : status === null ? <p className={styles.emptyState}><UiText text={"项目状态暂时无法读取，请稍后重试。"} /></p> : <>
          <section id="runtime-readiness" tabIndex={-1} className={styles.readinessDisclosure}>
            <button type="button" className={styles.readinessToggle} aria-expanded={readinessOpen} onClick={() => setReadinessSelection({ focus: navigation.focus, open: !readinessOpen })}>
              <span><UiText text={"运行条件与模型路由"} /></span><span className={status.readiness.runtimeDecision.canRun ? styles.readyBadge : styles.blockedBadge}>{status.readiness.runtimeDecision.canRun ? <UiText text={"当前可运行"} /> : <UiText text={"需要处理"} />}</span><span aria-hidden="true">{readinessOpen ? "−" : "+"}</span>
            </button>
            {readinessOpen ? <div className={styles.readinessContent}><ReadinessPanel readiness={status.readiness} latestSuccessAt={[...status.reports, ...status.agentRuns].map((entry) => entry.createdAt).sort().at(-1) ?? null} /><Link href={`/projects/${encodeURIComponent(projectId)}/configuration`} className={styles.configLink}><UiText text={"前往项目配置 →"} /></Link></div> : null}
          </section>
          <nav className={styles.tabs} role="tablist" aria-label={translateUi("简报与调查")}>
            <button id="brief-tab" type="button" role="tab" aria-selected={activeSection === "brief"} aria-controls="brief-panel" className={`${styles.tab} ${activeSection === "brief" ? styles.tabActive : ""}`} onClick={() => setSectionSelection({ focus: navigation.focus, section: "brief" })}><UiText text={"项目简报"} /></button>
            <button id="investigation-tab" type="button" role="tab" aria-selected={activeSection === "investigation"} aria-controls="investigation-panel" className={`${styles.tab} ${activeSection === "investigation" ? styles.tabActive : ""}`} onClick={() => setSectionSelection({ focus: navigation.focus, section: "investigation" })}><UiText text={"只读调查"} /></button>
          </nav>
          <div id={activeSection === "brief" ? "brief-panel" : "investigation-panel"} role="tabpanel" aria-labelledby={activeSection === "brief" ? "brief-tab" : "investigation-tab"} className={styles.tabPanel}>
            {activeSection === "brief" ? <BriefPanel projectId={projectId} report={status.reports[0] ?? null} canRun={status.readiness.runtimeDecision.canRun} onReload={reload} /> : <AgentPanel projectId={projectId} runs={status.agentRuns} tools={status.tools} canRun={status.readiness.runtimeDecision.canRun} onReload={reload} />}
          </div>
        </>}
        </div>
    </main>
  );
}

function routeDetail(route: ProviderRoute, error: RouteError | null): string {
  if (route === null) return error === null ? "暂不可用 · 路由来源未确认" : `暂不可用 · ${error.code}`;
  const provider = route.providerConnection?.name ?? route.providerConnection?.kind ?? route.sourceLabel;
  const model = route.modelId ?? "模型信息受限";
  return `${route.sourceLabel} · ${route.payerLabel} · ${provider} · ${model}`;
}

function ReadinessPanel({ readiness, latestSuccessAt }: { readiness: Readiness; latestSuccessAt: string | null }) {
  const translateUi = useTranslate();
  const decision = readiness.runtimeDecision;
  const checks = [
    { label: "项目分析路由", ready: readiness.generationRoute, detail: routeDetail(readiness.routes.generation, readiness.routeErrors.generation) },
    { label: "向量模型路由", ready: readiness.embeddingRoute, detail: routeDetail(readiness.routes.embedding, readiness.routeErrors.embedding) },
    { label: "兼容的记忆索引", ready: readiness.indexCompatible, detail: readiness.indexCompatible ? `索引 ${shortHash(readiness.indexGenerationId ?? "")}` : readiness.state === "legacyIndex" ? "旧版索引，需要重建" : readiness.state === "routeIncompatible" ? "向量路由已变化，需要重建" : readiness.state === "inputsChanged" ? "项目资料已变化，需要重建" : readiness.activeIndex ? "当前索引不可用于项目 AI" : "尚未建立" },
  ];
  const owner = decision.routeSource === "platform_default" ? "平台管理员维护" : decision.routeSource === "personal_delegation" ? "个人连接所有者（身份按权限隐藏）" : decision.routeSource === "mixed" ? "平台管理员与个人连接所有者" : "当前未取得";
  const affectedProjects = decision.routeSource === "platform_default" || decision.routeSource === "mixed" ? "当前项目正在使用；平台默认配置还可能影响未采用个人委派的其他项目" : "仅由完成双确认委派的项目使用；此处只展示当前项目";
  return <section className={`rounded-3xl border p-6 shadow-sm ${decision.canRun ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500"><UiText text={"Runtime readiness"} /></p><h2 className="mt-2 text-xl font-semibold">{decision.title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">{decision.detail}</p>{decision.payerLabel ? <p className="mt-2 text-xs font-semibold text-slate-600"><UiText text={"本次项目分析："} />{decision.payerLabel}</p> : null}</div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${decision.canRun ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{decision.canRun ? <UiText text={"可提交"} /> : <UiText text={"需处理"} />}</span></div><div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">{checks.map((check) => <div key={check.label} className="min-w-0 rounded-2xl border border-white/80 bg-white/80 p-4"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${check.ready ? "bg-emerald-500" : "bg-amber-400"}`} /><p className="min-w-0 text-sm font-semibold">{check.label}</p></div><p className="mt-2 truncate text-xs text-slate-500" title={check.detail}>{check.detail}</p></div>)}</div><div className="mt-5"><ScopeEvidenceCard title={translateUi("当前 AI 路由边界")} evidence={{ scope: "当前项目实际采用的向量与项目分析路由", owner, payer: decision.payerLabel ?? "当前未取得", affectedProjects, latestSuccess: latestSuccessAt ? `最近成功生成：${formatDate(latestSuccessAt)}` : "尚无成功的项目简报或调查记录" }} /></div><div className="mt-5 flex flex-wrap items-center gap-3"><span className="text-xs font-semibold text-slate-600"><UiText text={"下一步："} />{decision.nextAction.label}</span>{decision.nextAction.href ? <Link href={decision.nextAction.href} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">{decision.nextAction.label}</Link> : null}</div></section>;
}

function BriefPanel({ projectId, report, canRun, onReload }: { projectId: string; report: Report | null; canRun: boolean; onReload: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const prepareSequence = useRef(0);
  const prepareController = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function invalidatePrepareRequest() {
    prepareSequence.current += 1;
    prepareController.current?.abort();
    prepareController.current = null;
  }

  async function prepare() {
    const preparedClientKey = crypto.randomUUID();
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    invalidatePrepareRequest();
    const sequence = prepareSequence.current;
    const controller = new AbortController();
    prepareController.current = controller;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "prepare", clientKey: preparedClientKey }),
        signal: controller.signal,
      });
      if (sequence !== prepareSequence.current || controller.signal.aborted) return;
      if (!response.ok) {
        const failure = await readApiFailure(response, "外发摘要读取失败");
        throw new Error(failure.message ?? "外发摘要读取失败");
      }
      const payload = await response.json() as { confirmation: Confirmation };
      setConfirmation(payload.confirmation);
      setClientKey(preparedClientKey);
      setMessage("已读取本次外发摘要。请核对路由和范围后，点击确认并执行。");
    } catch (prepareError) {
      if (controller.signal.aborted || sequence !== prepareSequence.current) return;
      setMessage(prepareError instanceof Error ? prepareError.message : "外发摘要读取失败");
    } finally {
      if (sequence === prepareSequence.current) {
        setPending(false);
        if (prepareController.current === controller) prepareController.current = null;
      }
      endFlight(flightRef, flightToken);
    }
  }

  async function generate() {
    if (confirmation === null || clientKey === null) {
      setMessage("请先读取本次外发摘要。");
      return;
    }
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey }),
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, "项目简报生成失败");
        const nextStep = confirmationMessage(failure.code);
        if (nextStep !== null) { setConfirmation(null); setClientKey(null); }
        throw new Error(nextStep ?? failure.message ?? "项目简报生成失败");
      }
      setConfirmation(null); setClientKey(null);
      setMessage("当前状态简报已生成并保存"); await onReload();
    } catch (generateError) {
      setMessage(generateError instanceof Error ? generateError.message : "项目简报生成失败");
    } finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  function actionButton() {
    if (!canRun) return null;
    if (confirmation !== null) return <ConfirmationCard confirmation={confirmation} pending={pending} executeLabel={report ? "重新生成简报" : "生成当前状态简报"} onExecute={() => void generate()} />;
    return <button type="button" onClick={() => void prepare()} disabled={pending} className="rounded-xl border border-indigo-200 px-5 py-3 text-xs font-semibold text-indigo-700 hover:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-40">{pending ? <UiText text={"读取摘要中…"} /> : <UiText text={"读取本次外发摘要"} />}</button>;
  }

  return <section id="project-brief" className={`${styles.contentSection} scroll-mt-44`}><div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4"><div><h2 className="text-base font-semibold"><UiText text={"项目简报"} /></h2><p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500"><UiText text={"汇总有证据的进展、决策、问题、风险和关注事项。"} /></p></div>{actionButton()}</div>{confirmation === null && canRun ? <p className="mt-3 text-xs leading-5 text-slate-500"><UiText text={"先读取本次外发摘要，确认实际路由和范围后才会提交任务。"} /></p> : null}{message ? <p role="status" className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{message}</p> : null}{report ? <ReportView report={report} /> : <div className="mt-4 rounded-lg border border-dashed border-slate-200 px-5 py-8 text-center text-sm text-slate-500"><UiText text={"还没有项目简报。生成前会先展示本次外发摘要。"} /></div>}</section>;
}

function ReportView({ report }: { report: Report }) {
  const translateUi = useTranslate();
  const citationNumbers = useMemo(() => new Map(report.citations.map((citation, index) => [citation.id, index + 1])), [report.citations]);
  const statusStyle = { on_track: "bg-emerald-100 text-emerald-700", needs_attention: "bg-amber-100 text-amber-800", at_risk: "bg-rose-100 text-rose-700", insufficient_data: "bg-slate-100 text-slate-600", unknown: "bg-slate-100 text-slate-600" }[report.report.status];
  const statusLabel = { on_track: "进展正常", needs_attention: "需要关注", at_risk: "存在风险", insufficient_data: "资料不足", unknown: "证据不足" }[report.report.status];
  return <div className="mt-4"><div className="rounded-lg border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle}`}>{translateUi(statusLabel)}</span><span className="text-xs text-slate-500">{formatDate(report.createdAt)} · {report.providerConnection?.name ?? report.providerConnection?.kind ?? <UiText text={"个人连接"} />} / {report.modelId ?? <UiText text={"模型信息受限"} />}</span></div><h3 className="mt-3 text-lg font-semibold text-slate-900">{report.report.headline}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{report.report.summary}</p><CitationChips ids={report.report.citations} numbers={citationNumbers} /></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{reportSections.map((section) => <ObservationSection key={section.key} title={translateUi(section.label)} observations={report.report[section.key]} numbers={citationNumbers} />)}</div><EvidenceList citations={report.citations} /><RunMeta inputTokens={report.inputTokens} outputTokens={report.outputTokens} fingerprint={report.inputManifestFingerprint} /></div>;
}

function AgentPanel({ projectId, runs, tools, canRun, onReload }: { projectId: string; runs: AgentRun[]; tools: ToolTrace["tool"][]; canRun: boolean; onReload: () => Promise<void> }) {
  const translateUi = useTranslate();
  const [question, setQuestion] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const prepareSequence = useRef(0);
  const prepareController = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  function resetConfirmation() {
    prepareSequence.current += 1;
    prepareController.current?.abort();
    prepareController.current = null;
    setConfirmation(null);
    setClientKey(null);
  }

  async function prepare(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (question.trim().length < 2) return;
    const preparedClientKey = crypto.randomUUID();
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    prepareSequence.current += 1;
    prepareController.current?.abort();
    const sequence = prepareSequence.current;
    const controller = new AbortController();
    prepareController.current = controller;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "prepare", clientKey: preparedClientKey, question }),
        signal: controller.signal,
      });
      if (sequence !== prepareSequence.current || controller.signal.aborted) return;
      if (!response.ok) {
        const failure = await readApiFailure(response, "外发摘要读取失败");
        throw new Error(failure.message ?? "外发摘要读取失败");
      }
      const payload = await response.json() as { confirmation: Confirmation };
      setConfirmation(payload.confirmation);
      setClientKey(preparedClientKey);
      setMessage("已读取本次外发摘要。请核对路由和范围后，点击确认并执行。");
    } catch (prepareError) {
      if (controller.signal.aborted || sequence !== prepareSequence.current) return;
      setMessage(prepareError instanceof Error ? prepareError.message : "外发摘要读取失败");
    } finally {
      if (sequence === prepareSequence.current) {
        setPending(false);
        if (prepareController.current === controller) prepareController.current = null;
      }
      endFlight(flightRef, flightToken);
    }
  }

  async function ask() {
    if (confirmation === null || clientKey === null) {
      setMessage("请先读取本次外发摘要。");
      return;
    }
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey, question }),
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, "项目调查失败");
        const nextStep = confirmationMessage(failure.code);
        if (nextStep !== null) resetConfirmation();
        throw new Error(nextStep ?? failure.message ?? "项目调查失败");
      }
      resetConfirmation();
      setQuestion(""); setSelectedRunId(null); setMessage("只读调查已完成"); setPromptOpen(false); await onReload();
    } catch (askError) {
      setMessage(askError instanceof Error ? askError.message : "项目调查失败");
    } finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  return <section id="agent-investigation" className={`${styles.contentSection} scroll-mt-44`}><div className="border-b border-slate-100 pb-4"><h2 className="text-base font-semibold"><UiText text={"只读调查"} /></h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500"><UiText text={"只使用已校验的只读工具；回答保留引用，不会直接写入已确认事实。"} /></p><div className="mt-3 flex flex-wrap gap-1.5">{tools.map((tool) => <span key={tool} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{translateUi(toolLabels[tool])}</span>)}</div></div>{canRun ? <OperationPanel title={translateUi("发起只读调查")} triggerLabel="发起调查" open={promptOpen} onOpenChange={setPromptOpen} disabled={pending} variant="drawer" className="mt-4" description="先读取本次外发摘要；确认路由和范围后才能发送调查请求。历史记录和调查结果留在下方查看。"><form onSubmit={(event) => void prepare(event)}><label className="block text-sm font-semibold text-slate-700"><UiText text={"你想了解什么？"} /><textarea value={question} onChange={(event) => { setQuestion(event.target.value); resetConfirmation(); }} minLength={2} maxLength={2_000} rows={4} placeholder={translateUi("例如：目前最需要关注的风险是什么？哪些决策仍缺少证据？")} className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-indigo-400 focus:bg-white" /></label>{confirmation ? <ConfirmationCard confirmation={confirmation} pending={pending} executeLabel="开始只读调查" onExecute={() => void ask()} /> : <div className="mt-4 flex items-center justify-between gap-4"><p className="text-xs text-slate-500"><UiText text={"仅执行项目概览、已确认条目、记忆和仓库状态只读查询。"} /></p><button disabled={pending || question.trim().length < 2} className="shrink-0 rounded-lg border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-800 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40">{pending ? <UiText text={"读取摘要中…"} /> : <UiText text={"读取本次外发摘要"} />}</button></div>}{message ? <p role="status" className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{message}</p> : null}</form></OperationPanel> : null}{message && !promptOpen ? <p role="status" className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{message}</p> : null}{runs.length > 1 ? <div className="mt-4 flex gap-2 overflow-x-auto pb-2">{runs.slice(0, 10).map((run) => <button key={run.id} type="button" onClick={() => setSelectedRunId(run.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${selectedRun?.id === run.id ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>{formatDate(run.createdAt)}</button>)}</div> : null}{selectedRun ? <AgentRunView run={selectedRun} /> : <div className="mt-4 rounded-lg border border-dashed border-slate-200 px-5 py-8 text-center text-sm text-slate-500"><UiText text={"还没有调查记录。发起只读问题后，回答与证据轨迹会保存在这里。"} /></div>}</section>;
}

function AgentRunView({ run }: { run: AgentRun }) {
  const translateUi = useTranslate();
  const citationNumbers = useMemo(() => new Map(run.citations.map((citation, index) => [citation.id, index + 1])), [run.citations]);
  return <article className="mt-4"><div className="rounded-lg border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-400"><UiText text={"问题"} /></p><h3 className="mt-1 text-sm font-semibold">{run.question}</h3><p className="mt-2 text-xs text-slate-500">{formatDate(run.createdAt)} · {run.providerConnection?.name ?? run.providerConnection?.kind ?? <UiText text={"个人连接"} />} / {run.modelId ?? <UiText text={"模型信息受限"} />}</p></div><div className="mt-3 rounded-lg border border-slate-200 bg-white p-4"><p className="text-xs font-semibold text-indigo-700"><UiText text={"有依据的回答"} /></p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{run.answer}</p><CitationChips ids={run.citations.map((citation) => citation.id)} numbers={citationNumbers} /></div>{run.recommendations.length > 0 ? <ObservationSection title={translateUi("建议")} observations={run.recommendations} numbers={citationNumbers} /> : null}{run.uncertainties.length > 0 ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4"><h4 className="text-sm font-semibold text-amber-900"><UiText text={"证据不足与不确定性"} /></h4><ul className="mt-2 space-y-2 text-sm leading-6 text-amber-900">{run.uncertainties.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul></div> : null}<ToolTraceView objective={run.plan.objective} trace={run.trace} /><EvidenceList citations={run.citations} /><RunMeta inputTokens={run.inputTokens} outputTokens={run.outputTokens} fingerprint={run.inputManifestFingerprint} /></article>;
}

function ObservationSection({ title, observations, numbers }: { title: string; observations: Observation[]; numbers: ReadonlyMap<string, number> }) {
  return <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"><h4 className="text-sm font-semibold text-slate-800">{title}</h4>{observations.length === 0 ? <p className="mt-3 text-sm text-slate-400"><UiText text={"暂无可验证内容"} /></p> : <ul className="mt-3 space-y-4">{observations.map((observation, index) => <li key={`${index}-${observation.text}`} className="text-sm leading-6 text-slate-600"><p>{observation.text}</p><CitationChips ids={observation.citations} numbers={numbers} /></li>)}</ul>}</section>;
}

function CitationChips({ ids, numbers }: { ids: string[]; numbers: ReadonlyMap<string, number> }) {
  return <span className="mt-3 flex flex-wrap gap-1.5">{[...new Set(ids)].map((id) => <span key={id} title={id} className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[12px] font-semibold text-indigo-700"><UiText text={"证据"} />{" "}{numbers.get(id) ?? "?"}</span>)}</span>;
}

function EvidenceList({ citations }: { citations: Citation[] }) {
  const translateUi = useTranslate();
  if (citations.length === 0) return null;
  return <section className="mt-6 min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold"><UiText text={"证据快照"} /></h4><div className="mt-4 min-w-0 divide-y divide-slate-100">{citations.map((citation, index) => <details key={citation.id} className="min-w-0 py-3"><summary className="flex min-w-0 cursor-pointer list-none items-start gap-2 text-sm font-medium text-slate-700"><span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{index + 1}</span><span className="min-w-0 [overflow-wrap:anywhere]">{citation.label}</span><span className="shrink-0 text-xs font-normal text-slate-400">{translateUi(citationKindLabels[citation.kind])}</span></summary><div className="mt-3 min-w-0 max-w-full text-xs leading-5 text-slate-500 sm:ml-8"><p className="max-w-full whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-slate-600 [overflow-wrap:anywhere]">{citation.excerpt}</p>{citation.path ? <p className="mt-2 [overflow-wrap:anywhere]"><UiText text={"路径："} />{citation.path}</p> : null}{citation.externalRef ? <p className="mt-1 break-all"><UiText text={"来源："} />{citation.externalRef}</p> : null}{citation.frozenCommitSha ? <p className="mt-1 break-all font-mono"><UiText text={"冻结 commit："} />{citation.frozenCommitSha}</p> : null}<p className="mt-1 break-all font-mono"><UiText text={"SHA-256："} />{citation.contentHash}</p></div></details>)}</div></section>;
}

function ToolTraceView({ objective, trace }: { objective: string; trace: ToolTrace[] }) {
  const translateUi = useTranslate();
  return <section className="mt-6 rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold"><UiText text={"只读调查轨迹"} /></h4><p className="mt-2 text-sm leading-6 text-slate-500"><UiText text={"目标："} />{objective}</p><ol className="mt-4 space-y-3">{trace.map((entry, index) => <li key={`${index}-${entry.tool}`} className="flex items-start gap-3 rounded-xl bg-slate-50 p-4"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">{index + 1}</span><div><p className="text-sm font-semibold">{translateUi(toolLabels[entry.tool])}</p><p className="mt-1 text-xs text-slate-500"><UiText text={"返回"} />{" "}{entry.resultCount} {" "}<UiText text={"条证据 · 参数"} />{" "}{JSON.stringify(entry.arguments)}</p></div></li>)}</ol></section>;
}

function RunMeta({ inputTokens, outputTokens, fingerprint }: { inputTokens: number; outputTokens: number; fingerprint: string }) {
  return <p className="mt-4 text-[12px] leading-5 text-slate-400"><UiText text={"输入"} />{" "}{inputTokens} {" "}<UiText text={"tokens · 输出"} />{" "}{outputTokens} {" "}<UiText text={"tokens · 输入清单"} />{" "}{shortHash(fingerprint)}</p>;
}
