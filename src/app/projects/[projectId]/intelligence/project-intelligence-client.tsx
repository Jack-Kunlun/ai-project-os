"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { KnowledgeLifecycle } from "@/components/knowledge-lifecycle";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { parseProjectPageState } from "@/lib/project-navigation";
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
    <p className="text-sm font-semibold text-indigo-900">本次外发摘要</p>
    <p className="mt-2 text-xs leading-5 text-indigo-800">动作：{confirmation.targetAction} · 路由：{summaryText(confirmation.safeSummary.route)} · 范围：{summaryText(confirmation.safeSummary.scope)}</p>
    {typeof defaultCount === "number" && defaultCount > 0 ? <p className="mt-2 text-xs leading-5 text-indigo-800">本次还会发送你标记的 {defaultCount} 条个人通用记忆；当前项目约定优先。原始文档仍属于个人知识库，但项目成员可查看生成结果，结果可能复述其中内容。</p> : null}
    <p className="mt-2 text-xs text-indigo-700">确认有效期至 {formatDate(confirmation.expiresAt)}。摘要不包含原文、问题或指纹。</p>
    <button type="button" onClick={onExecute} disabled={pending} className="mt-4 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? "执行中…" : executeLabel}</button>
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
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("intelligence", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const [projectName, setProjectName] = useState("项目");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [projectResponse, statusResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/intelligence/status`, { cache: "no-store" }),
      ]);
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
      setError(loadError instanceof Error ? loadError.message : "项目智能体加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

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
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="intelligence" isSystemAdmin={isSystemAdmin} />
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-10 sm:px-10 lg:px-12">
        <section className="pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Project AI workspace</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName} · AI 工作台</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">在一个入口看清项目能用哪些 AI、需要什么前置条件，以及到哪里创建记忆、做查询或运行只读调查。所有生成结果都保留引用，不会自动写入已确认事实。</p>
        </section>

        {navigation.returnTo ? <Link href={navigation.returnTo} className="mb-6 inline-flex text-sm font-semibold text-indigo-700">← 返回来源页面</Link> : null}

        <div className="space-y-7">
          <CapabilityOverview projectId={projectId} readiness={status?.readiness ?? null} />
          {error ? <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
          {loading || status === null ? <div className="h-48 animate-pulse rounded-3xl bg-slate-200" aria-label="正在加载项目智能体" /> : (
            <>
              <div id="runtime-readiness" tabIndex={-1} className="scroll-mt-44 outline-none focus:ring-4 focus:ring-indigo-100"><ReadinessPanel readiness={status.readiness} latestSuccessAt={[...status.reports, ...status.agentRuns].map((entry) => entry.createdAt).sort().at(-1) ?? null} /></div>
              <BriefPanel projectId={projectId} report={status.reports[0] ?? null} canRun={status.readiness.runtimeDecision.canRun} onReload={reload} />
              <AgentPanel projectId={projectId} runs={status.agentRuns} tools={status.tools} canRun={status.readiness.runtimeDecision.canRun} onReload={reload} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function CapabilityOverview({ projectId, readiness }: { projectId: string; readiness: Readiness | null }) {
  const loading = readiness === null;
  const memoryReady = readiness?.embeddingRoute === true && readiness.indexCompatible;
  const projectAiReady = readiness?.runtimeDecision.canRun === true;
  const memoryRuntimeBlocked = readiness !== null && ["run_forbidden", "platform_route_blocked", "personal_route_blocked", "platform_quota_advisory_blocked"].includes(readiness.runtimeDecision.code);
  const memoryMissing = loading ? "正在读取向量路由与索引状态。" : memoryRuntimeBlocked ? readiness.runtimeDecision.detail : !readiness.embeddingRoute ? "缺少可用的向量路由。" : !readiness.indexCompatible ? "缺少与当前路由兼容的记忆索引。" : "无缺失项。";
  const memoryAction = loading
    ? { label: "等待状态加载", href: null }
    : memoryRuntimeBlocked
      ? readiness.runtimeDecision.nextAction
      : memoryReady
        ? { label: "打开项目记忆", href: `/projects/${projectId}/memory` }
        : { label: readiness.state === "indexMissing" ? "建立项目记忆" : "重建项目记忆", href: `/projects/${projectId}/memory` };
  const projectAiMissing = loading ? "正在读取项目分析路由与索引状态。" : projectAiReady ? "无缺失项。" : readiness.runtimeDecision.detail;
  const cards = [
    {
      title: "识别与抽取",
      detail: "解析文档、识别图片和扫描件，并从资料中生成待人工审核的候选。",
      state: loading ? "状态读取中" : "提交时校验",
      condition: "需要原始资料，以及提交时通过 visionExtract 或 autoExtract 路由校验。",
      missing: loading ? "正在读取项目状态。" : "当前状态接口未提供识别与抽取路由的就绪证据。",
      href: loading ? null : `/projects/${projectId}/assets`,
      action: loading ? "等待状态加载" : "前往资料与资源并在提交时校验",
      tone: "border-violet-200 bg-violet-50 text-violet-800",
      ready: false,
    },
    {
      title: "记忆检索与问答",
      detail: "建立向量索引，做语义检索，或生成只能引用本次命中证据的回答。",
      state: loading ? "状态读取中" : memoryReady ? "已就绪" : "未就绪",
      condition: "需要可用的向量路由，以及与当前输入和路由兼容的记忆索引。",
      missing: memoryMissing,
      href: memoryAction.href,
      action: memoryAction.label,
      tone: "border-indigo-200 bg-indigo-50 text-indigo-800",
      ready: memoryReady,
    },
    {
      title: "项目简报与调查",
      detail: "读取项目概览、已确认事实、记忆和仓库状态，生成简报或回答项目问题。",
      state: loading ? "状态读取中" : projectAiReady ? "已就绪" : "未就绪",
      condition: "需要可用的项目分析路由、兼容记忆索引与项目编辑权限。",
      missing: projectAiMissing,
      href: loading || !projectAiReady ? readiness?.runtimeDecision.nextAction.href ?? null : "#agent-investigation",
      action: loading ? "等待状态加载" : projectAiReady ? "开始只读调查" : readiness!.runtimeDecision.nextAction.label,
      tone: "border-cyan-200 bg-cyan-50 text-cyan-800",
      ready: projectAiReady,
    },
  ] as const;
  return <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Available capabilities</p><h2 className="mt-2 text-xl font-semibold">当前 AI 能力</h2><p className="mt-2 text-xs leading-5 text-slate-500">每张卡都按当前项目状态说明就绪条件、缺失项和唯一下一步；不会把已实现能力误写成已配置就绪。</p></div><div className="mt-5"><KnowledgeLifecycle compact /></div><div className="mt-5 grid gap-3 md:grid-cols-3">{cards.map((card) => {
    const body = <><div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{card.title}</h3><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${card.ready ? "bg-emerald-100 text-emerald-700" : "bg-white/80 text-slate-600"}`}>{card.state}</span></div><p className="mt-2 text-xs leading-5 opacity-80">{card.detail}</p><dl className="mt-4 space-y-2 text-xs leading-5"><div><dt className="font-semibold">就绪条件</dt><dd className="opacity-80">{card.condition}</dd></div><div><dt className="font-semibold">当前缺失</dt><dd className="opacity-80">{card.missing}</dd></div></dl><span className="mt-4 block text-xs font-semibold">下一步：{card.action}{card.href ? " →" : ""}</span></>;
    return card.href ? <Link key={card.title} href={card.href} className={`min-w-0 rounded-2xl border p-5 transition hover:-translate-y-0.5 hover:shadow-sm ${card.tone}`}>{body}</Link> : <article key={card.title} className={`min-w-0 rounded-2xl border p-5 opacity-80 ${card.tone}`}>{body}</article>;
  })}</div></section>;
}

function routeDetail(route: ProviderRoute, error: RouteError | null): string {
  if (route === null) return error === null ? "暂不可用 · 路由来源未确认" : `暂不可用 · ${error.code}`;
  const provider = route.providerConnection?.name ?? route.providerConnection?.kind ?? route.sourceLabel;
  const model = route.modelId ?? "模型信息受限";
  return `${route.sourceLabel} · ${route.payerLabel} · ${provider} · ${model}`;
}

function ReadinessPanel({ readiness, latestSuccessAt }: { readiness: Readiness; latestSuccessAt: string | null }) {
  const decision = readiness.runtimeDecision;
  const checks = [
    { label: "项目分析路由", ready: readiness.generationRoute, detail: routeDetail(readiness.routes.generation, readiness.routeErrors.generation) },
    { label: "向量模型路由", ready: readiness.embeddingRoute, detail: routeDetail(readiness.routes.embedding, readiness.routeErrors.embedding) },
    { label: "兼容的记忆索引", ready: readiness.indexCompatible, detail: readiness.indexCompatible ? `索引 ${shortHash(readiness.indexGenerationId ?? "")}` : readiness.state === "legacyIndex" ? "旧版索引，需要重建" : readiness.state === "routeIncompatible" ? "向量路由已变化，需要重建" : readiness.state === "inputsChanged" ? "项目资料已变化，需要重建" : readiness.activeIndex ? "当前索引不可用于项目 AI" : "尚未建立" },
  ];
  const owner = decision.routeSource === "platform_default" ? "平台管理员维护" : decision.routeSource === "personal_delegation" ? "个人连接所有者（身份按权限隐藏）" : decision.routeSource === "mixed" ? "平台管理员与个人连接所有者" : "当前未取得";
  const affectedProjects = decision.routeSource === "platform_default" || decision.routeSource === "mixed" ? "当前项目正在使用；平台默认配置还可能影响未采用个人委派的其他项目" : "仅由完成双确认委派的项目使用；此处只展示当前项目";
  return <section className={`rounded-3xl border p-6 shadow-sm ${decision.canRun ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Runtime readiness</p><h2 className="mt-2 text-xl font-semibold">{decision.title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">{decision.detail}</p>{decision.payerLabel ? <p className="mt-2 text-xs font-semibold text-slate-600">本次项目分析：{decision.payerLabel}</p> : null}</div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${decision.canRun ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{decision.canRun ? "可提交" : "需处理"}</span></div><div className="mt-5 grid gap-3 md:grid-cols-3">{checks.map((check) => <div key={check.label} className="rounded-2xl border border-white/80 bg-white/80 p-4"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${check.ready ? "bg-emerald-500" : "bg-amber-400"}`} /><p className="text-sm font-semibold">{check.label}</p></div><p className="mt-2 truncate text-xs text-slate-500" title={check.detail}>{check.detail}</p></div>)}</div><div className="mt-5"><ScopeEvidenceCard title="当前 AI 路由边界" evidence={{ scope: "当前项目实际采用的向量与项目分析路由", owner, payer: decision.payerLabel ?? "当前未取得", affectedProjects, latestSuccess: latestSuccessAt ? `最近成功生成：${formatDate(latestSuccessAt)}` : "尚无成功的项目简报或调查记录" }} /></div><div className="mt-5 flex flex-wrap items-center gap-3"><span className="text-xs font-semibold text-slate-600">下一步：{decision.nextAction.label}</span>{decision.nextAction.href ? <Link href={decision.nextAction.href} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">{decision.nextAction.label}</Link> : null}</div></section>;
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
    return <button type="button" onClick={() => void prepare()} disabled={pending} className="rounded-xl border border-indigo-200 px-5 py-3 text-xs font-semibold text-indigo-700 hover:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-40">{pending ? "读取摘要中…" : "读取本次外发摘要"}</button>;
  }

  return <section id="project-brief" className="scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-start justify-between gap-5 border-b border-slate-100 pb-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Current state brief</p><h2 className="mt-2 text-2xl font-semibold">项目当前状态</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">聚合已确认条目、当前索引和仓库状态，生成可追溯的进展、决策、问题、风险与关注事项。</p></div>{actionButton()}</div>{confirmation === null && canRun ? <p className="mt-4 text-xs leading-5 text-slate-500">先读取本次外发摘要，确认实际路由、范围和有效期后，才会创建任务。</p> : null}{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}{report ? <ReportView report={report} /> : <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-500">还没有项目智能简报。完成上方下一步后，才可以生成并保存带证据的简报。</div>}</section>;
}

function ReportView({ report }: { report: Report }) {
  const citationNumbers = useMemo(() => new Map(report.citations.map((citation, index) => [citation.id, index + 1])), [report.citations]);
  const statusStyle = { on_track: "bg-emerald-100 text-emerald-700", needs_attention: "bg-amber-100 text-amber-800", at_risk: "bg-rose-100 text-rose-700", insufficient_data: "bg-slate-100 text-slate-600", unknown: "bg-slate-100 text-slate-600" }[report.report.status];
  const statusLabel = { on_track: "进展正常", needs_attention: "需要关注", at_risk: "存在风险", insufficient_data: "资料不足", unknown: "证据不足" }[report.report.status];
  return <div className="mt-7"><div className="rounded-2xl bg-slate-950 p-6 text-white"><div className="flex flex-wrap items-center justify-between gap-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle}`}>{statusLabel}</span><span className="text-xs text-slate-400">{formatDate(report.createdAt)} · {report.providerConnection?.name ?? report.providerConnection?.kind ?? "个人连接"} / {report.modelId ?? "模型信息受限"}</span></div><h3 className="mt-5 text-2xl font-semibold">{report.report.headline}</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-300">{report.report.summary}</p><CitationChips ids={report.report.citations} numbers={citationNumbers} /></div><div className="mt-6 grid gap-4 lg:grid-cols-2">{reportSections.map((section) => <ObservationSection key={section.key} title={section.label} observations={report.report[section.key]} numbers={citationNumbers} />)}</div><EvidenceList citations={report.citations} /><RunMeta inputTokens={report.inputTokens} outputTokens={report.outputTokens} fingerprint={report.inputManifestFingerprint} /></div>;
}

function AgentPanel({ projectId, runs, tools, canRun, onReload }: { projectId: string; runs: AgentRun[]; tools: ToolTrace["tool"][]; canRun: boolean; onReload: () => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const prepareSequence = useRef(0);
  const prepareController = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
      setQuestion(""); setSelectedRunId(null); setMessage("只读调查已完成"); await onReload();
    } catch (askError) {
      setMessage(askError instanceof Error ? askError.message : "项目调查失败");
    } finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  return <section id="agent-investigation" className="scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Read-only investigation</p><h2 className="mt-2 text-2xl font-semibold">向项目智能体提问</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">模型只能从固定工具中规划调查；服务端逐项校验并执行只读查询，最终回答只能引用本次工具取得的证据。</p><div className="mt-4 flex flex-wrap gap-2">{tools.map((tool) => <span key={tool} className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">{toolLabels[tool]}</span>)}</div></div>{canRun ? <form onSubmit={(event) => void prepare(event)} className="mt-6"><label className="block text-sm font-semibold text-slate-700">你想了解什么？<textarea value={question} onChange={(event) => { setQuestion(event.target.value); resetConfirmation(); }} minLength={2} maxLength={2_000} rows={4} placeholder="例如：目前最需要关注的风险是什么？哪些关键决策仍缺少证据？" className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 outline-none transition focus:border-indigo-400 focus:bg-white" /></label>{confirmation ? <ConfirmationCard confirmation={confirmation} pending={pending} executeLabel="开始只读调查" onExecute={() => void ask()} /> : <div className="mt-4 flex items-center justify-between gap-4"><p className="text-xs text-slate-500">不提供 Shell、文件系统、代码修改或 GitHub 写入工具。</p><button disabled={pending || question.trim().length < 2} className="shrink-0 rounded-xl border border-slate-300 px-5 py-3 text-xs font-semibold text-slate-800 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40">{pending ? "读取摘要中…" : "读取本次外发摘要"}</button></div>}</form> : null}{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}{runs.length > 1 ? <div className="mt-7 flex gap-2 overflow-x-auto pb-2">{runs.slice(0, 10).map((run) => <button key={run.id} type="button" onClick={() => setSelectedRunId(run.id)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-semibold ${selectedRun?.id === run.id ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>{formatDate(run.createdAt)}</button>)}</div> : null}{selectedRun ? <AgentRunView run={selectedRun} /> : <div className="mt-7 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-500">还没有调查记录。完成上方下一步后，可提交一个只读问题并保存证据轨迹。</div>}</section>;
}

function AgentRunView({ run }: { run: AgentRun }) {
  const citationNumbers = useMemo(() => new Map(run.citations.map((citation, index) => [citation.id, index + 1])), [run.citations]);
  return <article className="mt-7"><div className="rounded-2xl border border-slate-200 bg-slate-50 p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Question</p><h3 className="mt-2 text-lg font-semibold">{run.question}</h3><p className="mt-2 text-xs text-slate-500">{formatDate(run.createdAt)} · {run.providerConnection?.name ?? run.providerConnection?.kind ?? "个人连接"} / {run.modelId ?? "模型信息受限"}</p></div><div className="mt-4 rounded-2xl bg-slate-950 p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Grounded answer</p><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-200">{run.answer}</p><CitationChips ids={run.citations.map((citation) => citation.id)} numbers={citationNumbers} /></div>{run.recommendations.length > 0 ? <ObservationSection title="建议" observations={run.recommendations} numbers={citationNumbers} /> : null}{run.uncertainties.length > 0 ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h4 className="text-sm font-semibold text-amber-900">证据不足与不确定性</h4><ul className="mt-3 space-y-2 text-sm leading-6 text-amber-900">{run.uncertainties.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul></div> : null}<ToolTraceView objective={run.plan.objective} trace={run.trace} /><EvidenceList citations={run.citations} /><RunMeta inputTokens={run.inputTokens} outputTokens={run.outputTokens} fingerprint={run.inputManifestFingerprint} /></article>;
}

function ObservationSection({ title, observations, numbers }: { title: string; observations: Observation[]; numbers: ReadonlyMap<string, number> }) {
  return <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"><h4 className="text-sm font-semibold text-slate-800">{title}</h4>{observations.length === 0 ? <p className="mt-3 text-sm text-slate-400">暂无可验证内容</p> : <ul className="mt-3 space-y-4">{observations.map((observation, index) => <li key={`${index}-${observation.text}`} className="text-sm leading-6 text-slate-600"><p>{observation.text}</p><CitationChips ids={observation.citations} numbers={numbers} /></li>)}</ul>}</section>;
}

function CitationChips({ ids, numbers }: { ids: string[]; numbers: ReadonlyMap<string, number> }) {
  return <span className="mt-3 flex flex-wrap gap-1.5">{[...new Set(ids)].map((id) => <span key={id} title={id} className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[12px] font-semibold text-indigo-700">证据 {numbers.get(id) ?? "?"}</span>)}</span>;
}

function EvidenceList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return <section className="mt-6 min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold">证据快照</h4><div className="mt-4 min-w-0 divide-y divide-slate-100">{citations.map((citation, index) => <details key={citation.id} className="min-w-0 py-3"><summary className="flex min-w-0 cursor-pointer list-none items-start gap-2 text-sm font-medium text-slate-700"><span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{index + 1}</span><span className="min-w-0 [overflow-wrap:anywhere]">{citation.label}</span><span className="shrink-0 text-xs font-normal text-slate-400">{citation.kind}</span></summary><div className="mt-3 min-w-0 max-w-full text-xs leading-5 text-slate-500 sm:ml-8"><p className="max-w-full whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-slate-600 [overflow-wrap:anywhere]">{citation.excerpt}</p>{citation.path ? <p className="mt-2 [overflow-wrap:anywhere]">路径：{citation.path}</p> : null}{citation.externalRef ? <p className="mt-1 break-all">来源：{citation.externalRef}</p> : null}{citation.frozenCommitSha ? <p className="mt-1 break-all font-mono">冻结 commit：{citation.frozenCommitSha}</p> : null}<p className="mt-1 break-all font-mono">SHA-256：{citation.contentHash}</p></div></details>)}</div></section>;
}

function ToolTraceView({ objective, trace }: { objective: string; trace: ToolTrace[] }) {
  return <section className="mt-6 rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold">只读调查轨迹</h4><p className="mt-2 text-sm leading-6 text-slate-500">目标：{objective}</p><ol className="mt-4 space-y-3">{trace.map((entry, index) => <li key={`${index}-${entry.tool}`} className="flex items-start gap-3 rounded-xl bg-slate-50 p-4"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">{index + 1}</span><div><p className="text-sm font-semibold">{toolLabels[entry.tool]}</p><p className="mt-1 text-xs text-slate-500">返回 {entry.resultCount} 条证据 · 参数 {JSON.stringify(entry.arguments)}</p></div></li>)}</ol></section>;
}

function RunMeta({ inputTokens, outputTokens, fingerprint }: { inputTokens: number; outputTokens: number; fingerprint: string }) {
  return <p className="mt-4 text-[12px] leading-5 text-slate-400">输入 {inputTokens} tokens · 输出 {outputTokens} tokens · 输入清单 {shortHash(fingerprint)}</p>;
}
