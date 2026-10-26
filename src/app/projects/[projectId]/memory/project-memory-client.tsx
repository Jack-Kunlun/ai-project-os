"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { OperationPanel } from "@/components/operation-panel";
import { ProjectFlowGuide } from "@/components/project-flow-guide";
import { parseProjectPageState } from "@/lib/project-navigation";
import { AppHeader } from "@/components/app-header";
import { ProjectIntelligenceParentLink } from "@/components/project-parent-link";
import supportStyles from "../project-support.module.css";
import { formatUiDateTime } from "@/lib/ui-date-format";

type Source = {
  id: string;
  kind: string;
  originScope: "project" | "repository_link";
  externalRef: string | null;
  contentHash: string;
  ingestedAt: string;
  _count: { webAiCandidates: number };
};
type Candidate = {
  id: string;
  reviewStatus: "candidate" | "accepted" | "dismissed";
  modelId: string | null;
  createdAt: string;
  providerConnection: { name?: string; kind?: string; status?: string } | null;
  source: { id: string; kind: string; externalRef: string | null; contentHash: string };
  projectItem: {
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    reviewStatus: string;
    title: string;
    content: string;
    sourceExcerpt: string;
    updatedAt: string;
    admission?: { mode: "automatic" | "review_required"; reason: string } | null;
  };
};
type Citation = {
  id: string;
  scope: string;
  path: string | null;
  externalRef: string | null;
  frozenCommitSha: string | null;
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
};
type Answer = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  providerConnection: { name?: string; kind?: string } | null;
};
type SearchResult = Citation & { contentText: string; score: number; semanticScore: number; lexicalScore: number };
type IndexStatus = {
  activeIndex: null | {
    publishedAt: string;
    generation: {
      id: string;
      jobId?: string | null;
      status: "staging" | "building" | "complete" | "failed" | "unknown" | "superseded";
      buildMode: "full" | "incremental";
      modelId: string | null;
      dimensions: number | null;
      recordCount: number;
      inputManifestFingerprint: string | null;
      completedAt: string;
      providerConnection: { name?: string; kind?: string; status?: string } | null;
    };
  };
  latestJob: null | { id: string; status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled"; stage: string; failureCode: string | null; reconciliationRequired: boolean; createdAt: string; completedAt: string | null };
  compatible: boolean;
  readiness: "routeMissing" | "providerUnavailable" | "indexMissing" | "legacyIndex" | "routeIncompatible" | "inputsChanged" | "ready";
  inputs: { projectSourceCount: number; hasCodeSnapshot: boolean; repositoryMaterialGenerationCount: number; manifestFingerprint: string | null };
  route: null | { source: string; modelId: string | null; embeddingDimensions: number | null; providerConnection: { name?: string; kind?: string; status?: string } | null };
};

type IndexPlan = {
  planFingerprint: string;
  mode: "full" | "incremental";
  providerName: string | null;
  providerKind: string | null;
  providerStatus: string | null;
  modelId: string | null;
  dimensions: number | null;
  routeUpdatedAt?: string;
  currentInputManifestFingerprint: string | null;
  expectedInputCount: number;
  reuseCount: number;
  generateCount: number;
  deleteCount: number;
  baselineGenerationId: string | null;
  baselineManifestFingerprint: string | null;
  estimatedProviderCalls: number;
  deadlineAt: string;
  deadlineEligible: boolean;
  ineligibleCode: string | null;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message ?? fallback; }
  catch { return fallback; }
}

type Confirmation = {
  challengeId: string;
  targetAction: string;
  expiresAt: string;
  safeSummary: Record<string, unknown>;
};

type ApiFailure = { code?: string; message?: string };

async function readApiFailure(response: Response, fallback: string): Promise<ApiFailure> {
  try {
    const payload = await response.json() as { error?: ApiFailure };
    return { code: payload.error?.code, message: payload.error?.message ?? fallback };
  } catch { return { message: fallback }; }
}

function confirmationMessage(code: string | undefined): string | null {
  if (code === "MEMORY_INDEX_PLAN_STALE") return "索引计划已变化，请重新读取计划并确认后再构建。";
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
  const { language } = useAppearance();
  const defaultCount = (confirmation.safeSummary.scope as { personalDefaultCount?: unknown } | undefined)?.personalDefaultCount;
  return <div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4" role="status">
    <p className="text-sm font-semibold text-indigo-900"><UiText text={"本次外发摘要"} /></p>
    <p className="mt-2 text-xs leading-5 text-indigo-800"><UiText text={"动作："} />{confirmation.targetAction} {" "}<UiText text={"· 路由："} />{summaryText(confirmation.safeSummary.route)} {" "}<UiText text={"· 范围："} />{summaryText(confirmation.safeSummary.scope)}</p>
    {typeof defaultCount === "number" && defaultCount > 0 ? <p className="mt-2 text-xs leading-5 text-indigo-800"><UiText text={"本次还会发送你标记的"} />{" "}{defaultCount} {" "}<UiText text={"条个人通用记忆；当前项目约定优先。原始文档仍属于个人知识库，但项目成员可查看生成结果，结果可能复述其中内容。"} /></p> : null}
    <p className="mt-2 text-xs text-indigo-700"><UiText text={"确认有效期至"} />{" "}{dateLabel(confirmation.expiresAt, language)}<UiText text={"。摘要不包含原文、问题或指纹。"} /></p>
    <button type="button" onClick={onExecute} disabled={pending} className="mt-4 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? <UiText text={"执行中…"} /> : executeLabel}</button>
  </div>;
}

function dateLabel(value: string, language: "zh-CN" | "en"): string {
  return formatUiDateTime(new Date(value), language, { dateStyle: "medium", timeStyle: "short" });
}

export function ProjectMemoryClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const requestedFocus = parseProjectPageState("memory", projectId, new URLSearchParams(searchParams.toString())).focus;
  const [projectInfo, setProjectInfo] = useState({ id: projectId, name: "项目" });
  const projectName = projectInfo.id === projectId ? projectInfo.name : "项目";
  const [indexProjectId, setIndexProjectId] = useState<string | null>(null);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ projectId: string; message: string } | null>(null);

  const readVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const activeProject = useRef<string | null>(projectId);
  const invalidateRead = useCallback(() => {
    readVersion.current++;
    readController.current?.abort();
  }, []);
  useLayoutEffect(() => {
    activeProject.current = projectId;
    return () => { activeProject.current = null; invalidateRead(); };
  }, [projectId, invalidateRead]);
  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}): Promise<IndexStatus | null> => {
    if (activeProject.current !== projectId) return null;
    const version = ++readVersion.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = () => activeProject.current === projectId && !controller.signal.aborted && version === readVersion.current;
    if (showLoading) setLoading(true);
    try {
      const projectRead = fetch(`/api/projects/${projectId}`, { cache: "no-store", signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(await readError(response, "智能记忆加载失败"));
        const payload = await response.json() as { project: { name: string } };
        // Header metadata should not wait for the larger index-status projection.
        if (current()) setProjectInfo({ id: projectId, name: payload.project.name });
      });
      const statusRead = fetch(`/api/projects/${projectId}/memory/status`, { cache: "no-store", signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(await readError(response, "智能记忆加载失败"));
        return await response.json() as { index: IndexStatus; sources: Source[]; candidates: Candidate[]; answers: Answer[] };
      });
      const [, payload] = await Promise.all([projectRead, statusRead]);
      if (!current()) return null;
      setIndexProjectId(projectId); setIndex(payload.index); setSources(payload.sources); setCandidates(payload.candidates); setAnswers(payload.answers); setError(null); return payload.index;
    } catch (loadError) {
      if (current()) setError({ projectId, message: loadError instanceof Error ? loadError.message : "智能记忆加载失败" });
      return null;
    } finally { if (current()) setLoading(false); }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const hasIndexStatus = index !== null && indexProjectId === projectId;
  const currentError = error?.projectId === projectId ? error.message : null;
  useEffect(() => {
    if (loading || !hasIndexStatus || !["memory-index", "memory-extract", "memory-query"].includes(requestedFocus ?? "")) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(requestedFocus!);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, hasIndexStatus, requestedFocus]);

  return <main className={supportStyles.supportPage}><AppHeader username={username} active="projects" projectId={projectId} projectSection="memory" isSystemAdmin={isSystemAdmin} /><div data-page-content className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12"><div className="mb-5"><ProjectIntelligenceParentLink projectId={projectId} /></div><section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600"><UiText text={"AI memory workspace"} /></p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600"><UiText text={"查看项目记忆状态，通过语义检索和引用式问答找到答案。整理资料、维护索引和处理不确定内容均在独立操作区完成。"} /></p></section>{currentError ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><UiErrorText text={currentError} /> <button type="button" disabled={loading} onClick={() => void reload({ showLoading: true })} className="ml-3 inline-flex min-h-9 items-center rounded border border-current px-3 text-xs disabled:opacity-50"><UiText text="重试" /></button></div> : null}{loading || (!hasIndexStatus && !currentError) ? <div className="h-48 animate-pulse rounded-3xl bg-slate-200" /> : index && hasIndexStatus ? <><ProjectFlowGuide projectId={projectId} stage="memory" sourceCount={index.inputs.projectSourceCount + index.inputs.repositoryMaterialGenerationCount + (index.inputs.hasCodeSnapshot ? 1 : 0)} pendingCount={candidates.filter((candidate) => candidate.reviewStatus === "candidate").length} indexReady={index.readiness === "ready"} /><IndexPanel projectId={projectId} index={index} onReload={reload} /><ExtractPanel projectId={projectId} sources={sources} candidates={candidates} onReload={reload} /><QueryPanel projectId={projectId} index={index} answers={answers} onReload={reload} /></> : null}</div></main>;
}

function IndexPanel({ projectId, index, onReload }: { projectId: string; index: IndexStatus; onReload: () => Promise<IndexStatus | null> }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const prepareSequence = useRef(0);
  const prepareController = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"full" | "incremental">("full");
  const [plan, setPlan] = useState<IndexPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function invalidatePrepareRequest() {
    prepareSequence.current += 1;
    prepareController.current?.abort();
    prepareController.current = null;
  }

  const loadPlan = useCallback(async () => {
    if (!index.route) { setPlan(null); return; }
    invalidatePrepareRequest();
    setConfirmation(null);
    setClientKey(null);
    setPlanLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/index?mode=${mode}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "索引计划读取失败"));
      setPlan((await response.json() as { plan: IndexPlan }).plan);
    } catch (planError) {
      setPlan(null);
      setMessage(planError instanceof Error ? planError.message : "索引计划读取失败");
    } finally { setPlanLoading(false); }
  }, [index.route, mode, projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void loadPlan(), 0); return () => window.clearTimeout(timer); }, [loadPlan]);

  async function prepare() {
    if (plan === null || !plan.deadlineEligible || plan.ineligibleCode !== null) {
      setMessage("当前索引计划不可执行，请重新读取计划或先建立全量基线");
      return;
    }
    const preparedClientKey = crypto.randomUUID();
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    invalidatePrepareRequest();
    const sequence = prepareSequence.current;
    const controller = new AbortController();
    prepareController.current = controller;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "prepare", clientKey: preparedClientKey, mode, planFingerprint: plan.planFingerprint }),
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

  async function build() {
    if (plan === null || confirmation === null || clientKey === null) {
      setMessage("请先读取本次外发摘要。");
      return;
    }
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey, mode, planFingerprint: plan.planFingerprint }),
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, "索引构建失败");
        const nextStep = confirmationMessage(failure.code);
        if (nextStep !== null) {
          setConfirmation(null);
          setClientKey(null);
          if (failure.code === "MEMORY_INDEX_PLAN_STALE" || failure.code === "WEB_AI_CONFIRMATION_STALE") await loadPlan();
        }
        throw new Error(nextStep ?? failure.message ?? "索引构建失败");
      }
      const payload = await response.json() as { job: { status: string; result?: { indexGenerationId?: string } } };
      const refreshed = await onReload();
      const activeGenerationId = refreshed?.activeIndex?.generation.id;
      const switched = payload.job.status === "succeeded" &&
        payload.job.result?.indexGenerationId !== undefined &&
        activeGenerationId === payload.job.result.indexGenerationId &&
        refreshed?.activeIndex?.generation.status === "complete";
      setConfirmation(null);
      setClientKey(null);
      setMessage(switched
        ? "新索引已完成并原子切换"
        : payload.job.status === "succeeded"
          ? "任务已完成，但活动索引已发生变化；请以当前索引状态为准"
          : `索引任务状态：${payload.job.status}，旧索引保持不变`);
    } catch (buildError) {
      setMessage(buildError instanceof Error ? buildError.message : "索引构建失败");
    } finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  async function reconcile() {
    if (!index.latestJob || index.latestJob.status !== "unknown" || !index.latestJob.reconciliationRequired) return;
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/jobs/${index.latestJob.id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reconcile" }),
      });
      if (!response.ok) throw new Error(await readError(response, "索引结果协调失败"));
      const payload = await response.json() as {
        job?: { result?: { reconciliation?: "publishedLocally" | "explicitAbandon" } | null };
      };
      setMessage(payload.job?.result?.reconciliation === "publishedLocally"
        ? "已确认索引已在本地发布，任务已安全收口。"
        : "已放弃本次未知索引结果；旧活动索引保持不变，不会自动重试模型。 ");
      await onReload();
    } catch (reconcileError) { setMessage(reconcileError instanceof Error ? reconcileError.message : "索引结果协调失败"); }
    finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  const readinessLabels: Record<IndexStatus["readiness"], string> = {
    routeMissing: "未配置向量路由",
    providerUnavailable: "向量供应商不可用",
    indexMissing: "尚未建立索引",
    legacyIndex: "旧版索引，需要升级",
    routeIncompatible: "向量路由已变化，需要重建",
    inputsChanged: "资料输入已变化，需要重建",
    ready: "索引可用",
  };
  const ready = index.readiness === "ready";

  const changeMode = (nextMode: "full" | "incremental") => { invalidatePrepareRequest(); setMode(nextMode); setConfirmation(null); setClientKey(null); setPlan(null); };
  return <section id="memory-index" tabIndex={-1} className="scroll-mt-28 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={"Unified vector memory"} /></p><h2 className="mt-2 text-2xl font-semibold"><UiText text={"项目语义索引"} /></h2><p className="mt-2 text-sm leading-6 text-slate-500"><UiText text={"使用当前冻结的人工资料、仓库资料生成和项目代码快照。失败或未知不会替换上一个可用索引。"} /></p></div><div className="grid grid-cols-3 gap-2"><Metric label={translateUi("资料")} value={index.inputs.projectSourceCount} /><Metric label={translateUi("代码")} value={translateUi(index.inputs.hasCodeSnapshot ? "已冻结" : "无")} /><Metric label={translateUi("仓库资料")} value={index.inputs.repositoryMaterialGenerationCount} /></div></div>{index.activeIndex ? <div className={`mt-6 rounded-2xl border p-5 ${ready ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={`text-sm font-semibold ${ready ? "text-emerald-900" : "text-amber-900"}`}>{translateUi(readinessLabels[index.readiness])} · {index.activeIndex.generation.recordCount} {" "}<UiText text={"条记忆"} /></p><p className={`mt-1 text-xs ${ready ? "text-emerald-700" : "text-amber-700"}`}><UiText text={"索引："} />{index.activeIndex.generation.providerConnection?.name ?? index.activeIndex.generation.providerConnection?.kind ?? <UiText text={"个人连接"} />} · {index.activeIndex.generation.modelId ?? <UiText text={"模型信息受限"} />} · {index.activeIndex.generation.dimensions === null ? <UiText text={"维度受限"} /> : `${index.activeIndex.generation.dimensions} 维`} · {dateLabel(index.activeIndex.publishedAt, language)}</p><p className={`mt-1 text-xs ${ready ? "text-emerald-700" : "text-amber-700"}`}><UiText text={"当前路由："} />{index.route ? `${index.route.providerConnection?.name ?? index.route.providerConnection?.kind ?? "个人连接"} · ${index.route.modelId ?? "模型信息受限"} · ${index.route.embeddingDimensions ?? "未知"} 维` : <UiText text={"未配置"} />}</p></div>{index.activeIndex.generation.inputManifestFingerprint ? <code className={`text-[10px] ${ready ? "text-emerald-700" : "text-amber-700"}`}>{index.activeIndex.generation.inputManifestFingerprint.slice(0, 16)}…</code> : null}</div>{!ready ? <p className="mt-3 text-xs leading-5 text-amber-800">{index.readiness === "providerUnavailable" ? <UiText text={"当前向量供应商未通过连接测试或已停用，语义查询和项目智能体已暂停。"} /> : index.readiness === "legacyIndex" ? <UiText text={"这是旧版索引格式，升级后需首次全量重建；重建前语义查询和项目智能体保持暂停。"} /> : index.readiness === "inputsChanged" ? <UiText text={"资料或仓库快照已变化，旧索引不会混用新输入；请重建后恢复语义能力。"} /> : <UiText text={"当前向量供应商、模型或维度与该索引不一致，重建前已停用语义查询和项目智能体。"} />}</p> : null}</div> : <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">{translateUi(readinessLabels[index.readiness])}</div>}{ready ? <a href="#memory-query" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"><UiText text={"索引已就绪，去提问 →"} /></a> : null}{index.latestJob?.status === "unknown" && index.latestJob.reconciliationRequired ? <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><p><UiText text={"上一次索引请求结果未知，不能自动重试模型。"} /></p><button type="button" onClick={() => void reconcile()} disabled={pending} className="mt-3 rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold"><UiText text={"人工收口未知结果"} /></button></div> : null}{!index.route ? <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800"><UiText text={"当前没有可用的向量路由。普通用户使用平台默认模型；会员用户请先在"} />{" "}<Link href="/personal/models" className="font-semibold underline"><UiText text={"个人模型设置"} /></Link> {" "}<UiText text={"配置向量能力，项目 Owner 确认后才能使用个人模型。"} /></p> : <OperationPanel title={translateUi("维护项目语义索引")} triggerLabel={index.activeIndex ? "更新语义索引" : "建立语义索引"} className="mt-5">{message ? <p role="status" className="mb-3 text-sm text-slate-600"><UiFeedbackText text={message} /></p> : null}<div className="mt-5"><p className="text-sm font-semibold text-slate-700"><UiText text={"选择构建方式"} /></p><div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600"><label className="flex items-center gap-2"><input type="radio" name="memory-index-mode" checked={mode === "full"} onChange={() => changeMode("full")} /><UiText text={"全量构建（不复用旧向量）"} /></label><label className="flex items-center gap-2"><input type="radio" name="memory-index-mode" checked={mode === "incremental"} onChange={() => changeMode("incremental")} /><UiText text={"增量构建（仅复用兼容向量）"} /></label></div>{planLoading ? <p className="mt-3 text-xs text-slate-500"><UiText text={"正在计算当前计划…"} /></p> : plan ? <p className="mt-3 text-xs leading-5 text-slate-500"><UiText text={"当前路由："} />{plan.providerName ?? plan.providerKind ?? <UiText text={"当前路由"} />} · {plan.modelId ?? <UiText text={"模型信息受限"} />} · {plan.dimensions ?? <UiText text={"未知"} />} {" "}<UiText text={"维；输入"} />{" "}{plan.expectedInputCount} {" "}<UiText text={"条，需生成"} />{" "}{plan.generateCount} {" "}<UiText text={"条，复用"} />{" "}{plan.reuseCount} {" "}<UiText text={"条，删除"} />{" "}{plan.deleteCount} {" "}<UiText text={"条。"} />{plan.ineligibleCode === "MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED" ? <UiText text={"当前没有可复用的兼容全量基线，请先执行全量构建。"} /> : !plan.deadlineEligible ? <UiText text={"规模无法在一次请求期限内安全完成。"} /> : <UiText text={"计划可执行，读取摘要后才会发送选中内容。所有待生成片段会发送给该供应商；复用片段不会再次外发。"} />}</p> : null}</div>{confirmation ? <ConfirmationCard confirmation={confirmation} pending={pending} executeLabel={index.activeIndex ? `${mode === "full" ? "全量重建" : "增量重建"}并切换索引` : "建立语义索引"} onExecute={() => void build()} /> : <div className="mt-4 flex justify-end"><button type="button" onClick={() => void prepare()} disabled={pending || planLoading || plan === null || !plan.deadlineEligible || plan.ineligibleCode !== null} className="app-action-button app-action-button--compact rounded-xl bg-indigo-600 font-semibold text-white disabled:opacity-40">{pending ? <UiText text={"读取摘要中…"} /> : <UiText text={"读取本次外发摘要"} />}</button></div>}</OperationPanel>}{message ? <p role="status" className="mt-3 text-sm text-slate-600"><UiFeedbackText text={message} /></p> : null}</section>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div className="min-w-20 rounded-xl bg-slate-50 px-3 py-3 text-center"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>; }

const MAX_BATCH_SELECTION = 10;

function ExtractPanel({ projectId, sources, candidates, onReload }: { projectId: string; sources: Source[]; candidates: Candidate[]; onReload: () => Promise<unknown> }) {
  const translateUi = useTranslate();
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const prepareSequence = useRef(0);
  const prepareController = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [batchReviewAction, setBatchReviewAction] = useState<"accept" | "dismiss" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pendingCandidates = candidates.filter((candidate) => candidate.reviewStatus === "candidate");
  const pendingCandidateIds = new Set(pendingCandidates.map((candidate) => candidate.id));
  const activeSelectedCandidates = selectedCandidates.filter((id) => pendingCandidateIds.has(id));

  function invalidatePrepareRequest() {
    prepareSequence.current += 1;
    prepareController.current?.abort();
    prepareController.current = null;
  }

  function toggle(sourceId: string) {
    invalidatePrepareRequest();
    setConfirmation(null);
    setClientKey(null);
    setSelected((current) => current.includes(sourceId)
      ? current.filter((id) => id !== sourceId)
      : current.length < MAX_BATCH_SELECTION ? [...current, sourceId] : current);
  }

  function selectFirstSources() {
    invalidatePrepareRequest();
    setConfirmation(null);
    setClientKey(null);
    setSelected(sources.slice(0, MAX_BATCH_SELECTION).map((source) => source.id));
  }

  function invertSources() {
    invalidatePrepareRequest();
    setConfirmation(null);
    setClientKey(null);
    setSelected((current) => {
      const selectedSet = new Set(current);
      return sources.filter((source) => !selectedSet.has(source.id)).slice(0, MAX_BATCH_SELECTION).map((source) => source.id);
    });
  }

  function toggleCandidate(candidateId: string) {
    setSelectedCandidates((current) => {
      const available = current.filter((id) => pendingCandidateIds.has(id));
      return available.includes(candidateId)
        ? available.filter((id) => id !== candidateId)
        : available.length < MAX_BATCH_SELECTION ? [...available, candidateId] : available;
    });
  }

  function selectFirstCandidates() {
    setSelectedCandidates(pendingCandidates.slice(0, MAX_BATCH_SELECTION).map((candidate) => candidate.id));
  }

  function invertCandidates() {
    const selectedSet = new Set(activeSelectedCandidates);
    setSelectedCandidates(pendingCandidates.filter((candidate) => !selectedSet.has(candidate.id)).slice(0, MAX_BATCH_SELECTION).map((candidate) => candidate.id));
  }

  async function prepareExtract() {
    if (selected.length === 0) {
      setMessage("请先选择要分析的资料。");
      return;
    }
    const preparedClientKey = crypto.randomUUID();
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    invalidatePrepareRequest();
    const sequence = prepareSequence.current;
    const controller = new AbortController();
    prepareController.current = controller;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "prepare", clientKey: preparedClientKey, sourceIds: selected }),
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

  async function extract() {
    if (confirmation === null || clientKey === null) {
      setMessage("请先读取本次外发摘要。");
      return;
    }
    const flightToken = beginFlight(flightRef);
    if (flightToken === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "execute", challengeId: confirmation.challengeId, clientKey, sourceIds: selected }),
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, "自动抽取失败");
        const nextStep = confirmationMessage(failure.code);
        if (nextStep !== null) {
          setConfirmation(null);
          setClientKey(null);
        }
        throw new Error(nextStep ?? failure.message ?? "自动抽取失败");
      }
      const payload = await response.json() as { job?: { status?: string; result?: {
        candidateCount?: number;
        confirmedCount?: number;
        reviewRequiredCount?: number;
        duplicateCount?: number;
        returnedCandidateCount?: number;
        rejectedCandidateCount?: number;
        recoveredExcerptCount?: number;
        anchoredExcerptCount?: number;
      } | null } };
      if (payload.job?.status === "queued" || payload.job?.status === "running") {
        setSelected([]);
        setConfirmation(null);
        setClientKey(null);
        setMessage("资料整理任务已进入后台，可继续添加资料。在项目资料的「识别任务」栏目查看进度和已保存结果。");
        await onReload();
        return;
      }
      const result = payload.job?.result;
      const created = result?.candidateCount ?? 0;
      const confirmed = result?.confirmedCount ?? 0;
      const reviewRequired = result?.reviewRequiredCount ?? created;
      const duplicates = result?.duplicateCount ?? 0;
      const returned = result?.returnedCandidateCount ?? created + duplicates;
      const rejected = result?.rejectedCandidateCount ?? 0;
      const recovered = result?.recoveredExcerptCount ?? 0;
      const anchored = result?.anchoredExcerptCount ?? 0;
      setSelected([]);
      setConfirmation(null);
      setClientKey(null);
      if (returned > 0 && created === 0 && duplicates === 0 && rejected > 0) {
        setMessage(`供应商调用成功并返回 ${returned} 条，但 ${rejected} 条既未引用有效证据块，也不是原文中的连续摘录，因此系统未写入候选。建议一次只选 1 条较短资料重试，或在智能控制台切换生成模型。`);
      } else if (returned === 0) {
        setMessage("供应商调用成功，但模型未发现有充分原文证据的决策、进展、问题或风险；本次未生成候选。可换一条资料或缩小范围后重试。");
      } else {
        const details = [`自动形成 ${confirmed} 条事实`, `${reviewRequired} 条待处理`];
        if (rejected > 0) details.push(`跳过 ${rejected} 条无有效证据定位的输出`);
        if (anchored > 0) details.push(`通过证据块定位 ${anchored} 条原文`);
        if (recovered > 0) details.push(`校正 ${recovered} 条仅有空白差异的摘录`);
        if (duplicates > 0) details.push(`忽略 ${duplicates} 条重复记录`);
        setMessage(`${details.join("；")}。有证据的事实已入库，仅待处理内容需要人工介入。`);
      }
      await onReload();
    } catch (extractError) {
      setMessage(extractError instanceof Error ? extractError.message : "自动抽取失败");
    } finally {
      setPending(false);
      endFlight(flightRef, flightToken);
    }
  }

  async function submitReview(candidate: Candidate, action: "accept" | "dismiss") {
    const response = await fetch(`/api/projects/${projectId}/memory/candidates/${candidate.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, expectedItemUpdatedAt: candidate.projectItem.updatedAt }),
    });
    if (!response.ok) throw new Error(await readError(response, "候选审核失败"));
  }

  async function review(candidate: Candidate, action: "accept" | "dismiss") {
    if (reviewingId !== null || batchReviewAction !== null) return;
    setReviewingId(candidate.id);
    setMessage(null);
    try {
      await submitReview(candidate, action);
      await onReload();
      setMessage(action === "accept" ? "已确认 1 条记忆，候选列表已局部更新。" : "已驳回 1 条候选，列表已局部更新。");
    } catch (reviewError) {
      setMessage(reviewError instanceof Error ? reviewError.message : "候选审核失败");
    } finally {
      setReviewingId(null);
    }
  }

  async function batchReview(action: "accept" | "dismiss") {
    if (batchReviewAction !== null || reviewingId !== null || activeSelectedCandidates.length === 0) return;
    const selectedSet = new Set(activeSelectedCandidates);
    const batch = pendingCandidates.filter((candidate) => selectedSet.has(candidate.id)).slice(0, MAX_BATCH_SELECTION);
    if (batch.length === 0) return;
    setBatchReviewAction(action);
    setMessage(null);
    const succeeded: string[] = [];
    const failures: string[] = [];
    try {
      for (const candidate of batch) {
        try {
          await submitReview(candidate, action);
          succeeded.push(candidate.id);
        } catch (reviewError) {
          failures.push(reviewError instanceof Error ? reviewError.message : "候选审核失败");
        }
      }
      await onReload();
      const succeededSet = new Set(succeeded);
      setSelectedCandidates((current) => current.filter((id) => !succeededSet.has(id)));
      const actionLabel = action === "accept" ? "确认" : "驳回";
      setMessage(failures.length === 0
        ? `已批量${actionLabel} ${succeeded.length} 条候选，列表已局部更新。`
        : `已批量${actionLabel} ${succeeded.length} 条；${failures.length} 条未处理：${failures[0]}`);
    } catch (reviewError) {
      const reason = reviewError instanceof Error ? reviewError.message : "候选列表刷新失败";
      setMessage(`已处理 ${succeeded.length} 条，但候选列表刷新失败：${reason}`);
    } finally {
      setBatchReviewAction(null);
    }
  }

  const reviewBusy = reviewingId !== null || batchReviewAction !== null;

  return (
    <section id="auto-extract-review" className="mt-8 scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
      <div id="memory-extract" tabIndex={-1} className="scroll-mt-44 border-b border-slate-100 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={"Grounded extraction"} /></p>
        <h2 className="mt-2 text-2xl font-semibold"><UiText text={"资料整理与待处理内容"} /></h2>
        <p className="mt-2 text-sm leading-6 text-slate-500"><UiText text={"AI 整理会自动发布有逐字原文证据的内容，仅冲突、改写或不确定的内容进入待处理。新导入的资料也可直接在导入操作中完成整理。"} /></p>
      </div>

      <div className="mt-6 flex flex-wrap gap-4">
        <OperationPanel title={translateUi("整理已有项目资料")} triggerLabel="整理已有资料">{message ? <p role="status" className="mb-4 text-sm text-slate-600"><UiFeedbackText text={message} /></p> : null}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold"><UiText text={"选择资料（最多 10 条）"} /></h3>
            <span className="text-xs text-slate-400"><UiText text={"已选"} />{" "}{selected.length} {" "}<UiText text={"条"} /></span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={selectFirstSources} disabled={pending || sources.length === 0} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-40"><UiText text={"选中前 10 条"} /></button>
            <button type="button" onClick={invertSources} disabled={pending || sources.length === 0} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-40"><UiText text={"反选"} /></button>
          </div>
          <div className="mt-3 min-h-72 min-w-0 max-w-full flex-1 space-y-2 overflow-y-auto pr-1 lg:min-h-0" aria-label={translateUi("可选项目资料")}>
            {sources.length === 0 ? <p className="flex h-full min-h-64 items-center justify-center rounded-xl p-4 text-sm text-slate-500"><UiText text={"还没有项目资料。"} /></p> : sources.map((source) => (
              <label key={source.id} className={`flex min-w-0 max-w-full cursor-pointer items-start gap-3 rounded-xl border bg-white p-3 text-xs transition ${selected.includes(source.id) ? "border-indigo-300 ring-1 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}>
                <input type="checkbox" checked={selected.includes(source.id)} onChange={() => toggle(source.id)} disabled={pending} className="mt-0.5 shrink-0" />
                <span className="min-w-0 max-w-full"><span className="block font-semibold text-slate-700">{source.kind} · {source.originScope === "project" ? <UiText text={"项目资料"} /> : <UiText text={"仓库资料"} />}</span><span className="mt-1 block text-slate-400 [overflow-wrap:anywhere]">{source.externalRef ?? source.contentHash}</span></span>
              </label>
            ))}
          </div>
          {confirmation ? <ConfirmationCard confirmation={confirmation} pending={pending} executeLabel={`抽取 ${selected.length} 条资料`} onExecute={() => void extract()} /> : <button type="button" onClick={() => void prepareExtract()} disabled={pending || selected.length === 0} className="mt-4 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? <UiText text={"读取摘要中…"} /> : <UiText text={"读取本次外发摘要"} />}</button>}
        </div>

        </OperationPanel>
        <OperationPanel title={translateUi("处理不确定内容")} triggerLabel={translateUi("处理待确认内容（{count}）").replace("{count}", String(pendingCandidates.length))}>{message ? <p role="status" className="mb-4 text-sm text-slate-600"><UiFeedbackText text={message} /></p> : null}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h3 className="text-sm font-semibold"><UiText text={"待处理内容"} /></h3>
            <span className="shrink-0 text-xs text-slate-400">{pendingCandidates.length} {" "}<UiText text={"条 · 已选"} />{" "}{activeSelectedCandidates.length} {" "}<UiText text={"条"} /></span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={selectFirstCandidates} disabled={reviewBusy || pendingCandidates.length === 0} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-40"><UiText text={"选中前 10 条"} /></button>
            <button type="button" onClick={invertCandidates} disabled={reviewBusy || pendingCandidates.length === 0} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-40"><UiText text={"反选"} /></button>
            <button type="button" onClick={() => void batchReview("accept")} disabled={reviewBusy || activeSelectedCandidates.length === 0} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{batchReviewAction === "accept" ? <UiText text={"批量确认中…"} /> : <UiText text={"批量确认"} />}</button>
            <button type="button" onClick={() => void batchReview("dismiss")} disabled={reviewBusy || activeSelectedCandidates.length === 0} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-40">{batchReviewAction === "dismiss" ? <UiText text={"批量驳回中…"} /> : <UiText text={"批量驳回"} />}</button>
          </div>
          <div className="mt-3 min-h-72 max-h-[34rem] min-w-0 max-w-full flex-1 overflow-y-auto pr-2 lg:min-h-0" aria-label={translateUi("待处理内容列表")}>
            {pendingCandidates.length === 0 ? (
              <p className="flex h-full min-h-64 items-center justify-center py-6 text-center text-sm text-slate-500"><UiText text={"暂无待处理内容。"} /></p>
            ) : (
              <div className="space-y-3">{pendingCandidates.map((candidate) => (
                <article key={candidate.id} className={`min-w-0 max-w-full rounded-2xl border bg-white p-5 transition ${activeSelectedCandidates.includes(candidate.id) ? "border-indigo-300 ring-1 ring-indigo-100" : "border-slate-200"}`}>
                  <label className="flex min-w-0 cursor-pointer items-start gap-3">
                    <input type="checkbox" checked={activeSelectedCandidates.includes(candidate.id)} onChange={() => toggleCandidate(candidate.id)} disabled={reviewBusy} className="mt-1 shrink-0" aria-label={`选择候选：${candidate.projectItem.title}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">{candidate.projectItem.type}</span><span className="min-w-0 text-[12px] text-slate-400 [overflow-wrap:anywhere]">{candidate.providerConnection?.name ?? candidate.providerConnection?.kind ?? <UiText text={"个人连接"} />} · {candidate.modelId ?? <UiText text={"模型信息受限"} />}</span></span>
                      <span className="mt-3 block [overflow-wrap:anywhere] font-semibold text-slate-900">{candidate.projectItem.title}</span>
                    </span>
                  </label>
                  <p className="mt-2 text-sm leading-6 text-slate-600 [overflow-wrap:anywhere]">{candidate.projectItem.content}</p>
                  {candidate.projectItem.admission ? <p className="mt-3 text-xs font-medium text-amber-800"><UiText text={"待处理原因："} />{({ content_too_short: "原文信息不足", content_not_exact_source_text: "正文包含模型改写，需要核对", source_contains_uncertainty: "来源含计划、示例或未决内容", conflicting_confirmed_fact: "与同类已有事实存在冲突", source_requires_manual_review: "外部来源或工具结果需要人工核对" } as Record<string, string>)[candidate.projectItem.admission.reason] ?? <UiText text={"需要核对原文证据"} />}</p> : null}
                  <blockquote className="mt-4 border-l-2 border-indigo-200 pl-3 text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">{candidate.projectItem.sourceExcerpt}</blockquote>
                  <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void review(candidate, "accept")} disabled={reviewBusy} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{reviewingId === candidate.id ? <UiText text={"确认中…"} /> : <UiText text={"确认记忆"} />}</button><button type="button" onClick={() => void review(candidate, "dismiss")} disabled={reviewBusy} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">{reviewingId === candidate.id ? <UiText text={"处理中…"} /> : <UiText text={"驳回"} />}</button></div>
                </article>
              ))}</div>
            )}
          </div>
        </div>
        </OperationPanel>
      </div>
      {message ? <p role="status" className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600"><UiFeedbackText text={message} /></p> : null}
    </section>
  );
}

/** The ordinary project question entry, also embedded in the materials workspace. */
export function ProjectQuestionWorkspace({ projectId }: { projectId: string }) {
  const [workspace, setWorkspace] = useState<{ index: IndexStatus; answers: Answer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<IndexStatus | null> => {
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "项目资料读取失败"));
      const payload = await response.json() as { index: IndexStatus; answers: Answer[] };
      setWorkspace(payload); setError(null); return payload.index;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目资料读取失败"); return null; }
  }, [projectId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  if (error) return <div role="alert" className="mt-6 rounded-2xl bg-rose-50 p-5 text-sm text-rose-800"><UiErrorText text={error} /><button type="button" onClick={() => void load()} className="ml-3 font-semibold underline"><UiText text={"重新读取"} /></button></div>;
  if (!workspace) return <p role="status" className="mt-6 p-5 text-sm text-slate-600"><UiText text={"正在读取项目资料…"} /></p>;
  return <QueryPanel projectId={projectId} index={workspace.index} answers={workspace.answers} onReload={load} />;
}

function questionRouteLabel(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "当前项目模型";
  const route = value as Record<string, unknown>;
  const provider = typeof route.provider === "object" && route.provider !== null && !Array.isArray(route.provider) ? route.provider as Record<string, unknown> : {};
  return [provider.name ?? provider.kind, route.model ?? provider.model ?? route.modelId].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(" · ") || "当前项目模型";
}

function QueryPanel({ projectId, index, answers, onReload }: { projectId: string; index: IndexStatus; answers: Answer[]; onReload: () => Promise<IndexStatus | null> }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const [question, setQuestion] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [preparedMode, setPreparedMode] = useState<"index" | "search" | "answer" | null>(null);
  const [indexPlan, setIndexPlan] = useState<IndexPlan | null>(null);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const sequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const flightRef = useRef<symbol | null>(null);
  const questionRef = useRef(question);
  const continuation = useRef<"search" | "answer">("answer");
  const indexReady = index.readiness === "ready" && index.activeIndex !== null && index.compatible;
  const hasInputs = index.inputs.projectSourceCount + index.inputs.repositoryMaterialGenerationCount + Number(index.inputs.hasCodeSnapshot) > 0;

  function resetConfirmation() {
    sequence.current += 1; controllerRef.current?.abort(); controllerRef.current = null;
    setConfirmation(null); setClientKey(null); setPreparedMode(null); setIndexPlan(null);
  }
  useEffect(() => () => { sequence.current += 1; controllerRef.current?.abort(); }, []);

  async function prepare(mode: "search" | "answer", currentIndex: IndexStatus = index) {
    if (!questionRef.current.trim() || !hasInputs) return;
    const flight = beginFlight(flightRef); if (!flight) return;
    resetConfirmation();
    const requestSequence = sequence.current;
    const controller = new AbortController(); controllerRef.current = controller;
    const key = crypto.randomUUID(); const submittedQuestion = questionRef.current;
    setPending("prepare"); setMessage(null);
    try {
      let endpoint: string; let body: Record<string, unknown>; let nextMode: "index" | "search" | "answer" = mode;
      if (currentIndex.readiness !== "ready" || !currentIndex.activeIndex || !currentIndex.compatible) {
        const planResponse = await fetch(`/api/projects/${projectId}/memory/index?mode=full`, { cache: "no-store", signal: controller.signal });
        if (!planResponse.ok) throw new Error(await readError(planResponse, "暂时无法准备项目资料"));
        const plan = (await planResponse.json() as { plan: IndexPlan }).plan;
        if (!plan.deadlineEligible || plan.ineligibleCode !== null) throw new Error("本次资料暂时无法准备，请到识别任务查看运行状态或联系管理员核对模型配置。");
        if (requestSequence !== sequence.current || controller.signal.aborted) return;
        setIndexPlan(plan); continuation.current = mode; nextMode = "index";
        endpoint = "index"; body = { phase: "prepare", clientKey: key, mode: "full", planFingerprint: plan.planFingerprint };
      } else {
        endpoint = mode === "search" ? "search" : "answers";
        body = { phase: "prepare", clientKey: key, question: submittedQuestion };
      }
      const response = await fetch(`/api/projects/${projectId}/memory/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (requestSequence !== sequence.current || controller.signal.aborted) return;
      if (!response.ok) throw new Error(await readError(response, "本次发送范围读取失败"));
      const payload = await response.json() as { confirmation: Confirmation };
      setConfirmation(payload.confirmation); setClientKey(key); setPreparedMode(nextMode);
    } catch (cause) {
      if (!controller.signal.aborted && requestSequence === sequence.current) setMessage(cause instanceof Error ? cause.message : "暂时无法提问");
    } finally {
      if (requestSequence === sequence.current) { setPending(null); if (controllerRef.current === controller) controllerRef.current = null; }
      endFlight(flightRef, flight);
    }
  }

  async function run() {
    if (!confirmation || !clientKey || !preparedMode) return;
    const flight = beginFlight(flightRef); if (!flight) return;
    const mode = preparedMode; const submittedQuestion = questionRef.current; const requestSequence = sequence.current;
    let preparedIndex: IndexStatus | null = null;
    setPending("execute"); setMessage(null);
    try {
      const endpoint = mode === "index" ? "index" : mode === "search" ? "search" : "answers";
      const body = mode === "index"
        ? { phase: "execute", challengeId: confirmation.challengeId, clientKey, mode: "full", planFingerprint: indexPlan?.planFingerprint }
        : { phase: "execute", challengeId: confirmation.challengeId, clientKey, question: submittedQuestion };
      const response = await fetch(`/api/projects/${projectId}/memory/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const failure = await readApiFailure(response, "本次操作未完成");
        resetConfirmation();
        throw new Error(confirmationMessage(failure.code) ?? failure.message ?? "本次操作未完成");
      }
      const payload = await response.json() as { job: { status: string; result?: { results?: SearchResult[]; indexGenerationId?: string } } };
      resetConfirmation();
      if (payload.job.status !== "succeeded") throw new Error("任务尚未成功完成，请到识别任务查看状态；系统不会自动重试模型请求。");
      if (mode === "search") setResults(payload.job.result?.results ?? []);
      else {
        const refreshed = await onReload();
        if (mode === "index") {
          if (refreshed?.readiness !== "ready" || refreshed.activeIndex?.generation.id !== payload.job.result?.indexGenerationId) throw new Error("资料准备状态已变化，请重新提问以核对本次范围。");
          // Reading the answer summary is local preparation. The next model send still needs its own click.
          if (submittedQuestion === questionRef.current && requestSequence + 1 === sequence.current) preparedIndex = refreshed;
          setMessage("资料已准备好。核对下方发送范围后，即可继续提问。");
        } else setMessage("回答已保存，可展开引用核对原文。");
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "本次操作未完成"); }
    finally { setPending(null); endFlight(flightRef, flight); }
    if (preparedIndex) await prepare(continuation.current, preparedIndex);
  }

  const scope = confirmation?.safeSummary.scope as { personalDefaultCount?: number; inputCount?: number } | undefined;
  const route = confirmation?.safeSummary.route as Record<string, unknown> | undefined;
  return <section id="memory-query" tabIndex={-1} className="mt-6 scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm outline-none sm:p-8">
    <h2 className="text-2xl font-semibold"><UiText text={"问项目"} /></h2>
    <p className="mt-2 text-sm leading-6 text-slate-600"><UiText text={"直接输入问题，回答会附上项目资料的原文引用。资料有更新时，系统会在这里引导准备。"} /></p>
    {!hasInputs ? <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900"><UiText text={"项目还没有资料。"} /><Link href={`/projects/${projectId}/materials`} className="ml-2 font-semibold underline"><UiText text={"先去放资料"} /></Link></p> : null}
    <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void prepare("answer"); }}>
      <label className="text-sm font-semibold" htmlFor="memory-question"><UiText text={"你想了解什么？"} /></label>
      <textarea id="memory-question" value={question} onChange={(event) => { questionRef.current = event.target.value; setQuestion(event.target.value); resetConfirmation(); setPending(null); }} rows={3} maxLength={2000} required disabled={pending === "execute"} className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" placeholder={translateUi("例如：这次交付包含哪些内容，还有哪些问题没确认？")} />
      {confirmation ? <div role="region" aria-label={translateUi("确认本次发送")} className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h3 className="font-semibold text-amber-950">{preparedMode === "index" ? <UiText text={"先准备项目资料"} /> : <UiText text={"确认本次提问"} />}</h3>
        <p className="mt-2 text-sm leading-6 text-amber-900">{preparedMode === "index" ? `本次会将 ${indexPlan?.generateCount ?? scope?.inputCount ?? 0} 份资料片段发送给 ${questionRouteLabel(route)} 做提问准备，完成后继续在这里提问。` : `本次会把问题和命中的项目资料片段发送给 ${questionRouteLabel(route?.generation ?? route)}，生成带原文引用的回答。`}</p>
        {(scope?.personalDefaultCount ?? 0) > 0 ? <p className="mt-2 text-xs leading-5 text-amber-900"><UiText text={"还会使用你标记的"} />{" "}{scope?.personalDefaultCount} {" "}<UiText text={"条个人通用记忆；项目约定优先，项目成员可查看生成结果。"} /></p> : null}
        <p className="mt-2 text-xs text-amber-800"><UiText text={"本次确认有效期至"} />{" "}{dateLabel(confirmation.expiresAt, language)}<UiText text={"。模型用量按项目当前路由计入额度或供应商账单。"} /></p>
        <div className="mt-4 flex flex-wrap gap-3"><button type="button" onClick={() => void run()} disabled={pending !== null} className="min-h-11 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? <UiText text={"处理中…"} /> : preparedMode === "index" ? <UiText text={"确认并准备资料"} /> : preparedMode === "search" ? <UiText text={"确认查找原文"} /> : <UiText text={"确认提问"} />}</button><button type="button" onClick={resetConfirmation} disabled={pending !== null} className="min-h-11 px-3 text-sm font-semibold text-slate-700"><UiText text={"返回修改"} /></button></div>
      </div> : <button type="submit" disabled={!hasInputs || !question.trim() || pending !== null} className="mt-4 min-h-11 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? <UiText text={"正在准备…"} /> : <UiText text={"提问"} />}</button>}
    </form>
    {message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700"><UiFeedbackText text={message} /></p> : null}
    {indexReady ? <details className="mt-5 text-sm text-slate-600"><summary className="cursor-pointer"><UiText text={"只查找原文"} /></summary><button type="button" onClick={() => void prepare("search")} disabled={!question.trim() || pending !== null} className="mt-3 min-h-10 rounded-xl border border-slate-200 px-4 py-2 font-semibold"><UiText text={"查找原文"} /></button></details> : null}
    {results.length ? <div className="mt-5 space-y-3">{results.map((result) => <blockquote key={result.id} className="rounded-xl bg-slate-50 p-4 text-sm leading-6">{result.contentText}</blockquote>)}</div> : null}
    <div className="mt-8 border-t border-slate-100 pt-6"><h3 className="font-semibold"><UiText text={"回答记录"} /></h3>{answers.length === 0 ? <p className="mt-3 text-sm text-slate-500"><UiText text={"还没有提问。"} /></p> : <div className="mt-4 space-y-5">{answers.map((answer) => <article key={answer.id} className="rounded-2xl border border-slate-200 p-5"><p className="font-semibold text-indigo-700">{answer.question}</p><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">{answer.answer}</p><div className="mt-4 space-y-2">{answer.citations.map((citation, i) => <details key={citation.id} className="rounded-xl bg-slate-50 px-4 py-3"><summary className="cursor-pointer text-sm font-semibold"><UiText text={"引用原文"} />{" "}{i + 1}{citation.path ? ` · ${citation.path}` : ""}</summary><blockquote className="mt-3 border-l-2 border-indigo-200 pl-3 text-sm leading-6 text-slate-600">{citation.excerpt}</blockquote></details>)}</div><p className="mt-3 text-xs text-slate-400">{answer.providerConnection?.name ?? answer.providerConnection?.kind ?? <UiText text={"项目模型"} />} · {answer.modelId} · {dateLabel(answer.createdAt, language)}</p></article>)}</div>}</div>
  </section>;
}
