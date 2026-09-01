"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";

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
  modelId: string;
  createdAt: string;
  providerConnection: { name: string; kind: string };
  source: { id: string; kind: string; externalRef: string | null; contentHash: string };
  projectItem: {
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    reviewStatus: string;
    title: string;
    content: string;
    sourceExcerpt: string;
    updatedAt: string;
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
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  providerConnection: { name: string; kind: string };
};
type SearchResult = Citation & { contentText: string; score: number; semanticScore: number; lexicalScore: number };
type IndexStatus = {
  activeIndex: null | {
    publishedAt: string;
    generation: {
      id: string;
      jobId: string | null;
      status: "staging" | "building" | "complete" | "failed" | "unknown" | "superseded";
      buildMode: "full" | "incremental";
      providerConnectionId: string;
      modelId: string;
      dimensions: number;
      recordCount: number;
      inputManifestFingerprint: string;
      completedAt: string;
      providerConnection: { id: string; name: string; kind: string; status: string };
    };
  };
  latestJob: null | { id: string; status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled"; stage: string; failureCode: string | null; reconciliationRequired: boolean; createdAt: string; completedAt: string | null };
  compatible: boolean;
  readiness: "routeMissing" | "providerUnavailable" | "indexMissing" | "legacyIndex" | "routeIncompatible" | "inputsChanged" | "ready";
  inputs: { projectSourceCount: number; hasCodeSnapshot: boolean; repositoryMaterialGenerationCount: number; manifestFingerprint: string | null };
  route: null | { providerConnectionId: string; modelId: string; embeddingDimensions: number | null; providerConnection: { id: string; name: string; kind: string; status: string } };
};

type IndexPlan = {
  planFingerprint: string;
  mode: "full" | "incremental";
  providerConnectionId: string;
  providerName: string;
  providerKind: string;
  modelId: string;
  dimensions: number;
  routeUpdatedAt: string;
  currentInputManifestFingerprint: string;
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

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

export function ProjectMemoryClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<IndexStatus | null> => {
    setLoading(true);
    try {
      const [projectResponse, statusResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/memory/status`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !statusResponse.ok) {
        throw new Error(await readError(!projectResponse.ok ? projectResponse : statusResponse, "智能记忆加载失败"));
      }
      const projectPayload = await projectResponse.json() as { project: { name: string } };
      const payload = await statusResponse.json() as { index: IndexStatus; sources: Source[]; candidates: Candidate[]; answers: Answer[] };
      setProjectName(projectPayload.project.name); setIndex(payload.index); setSources(payload.sources); setCandidates(payload.candidates); setAnswers(payload.answers); setError(null); return payload.index;
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "智能记忆加载失败"); return null; }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="projects" projectId={projectId} projectSection="memory" /><div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12"><section className="pb-10 pt-12"><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">AI memory workspace</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">从可追溯原文自动抽取候选，建立跨人工资料与多仓库代码的向量记忆，并通过语义检索和引用式问答找到项目答案。</p></section>{error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}{loading || !index ? <div className="h-48 animate-pulse rounded-3xl bg-slate-200" /> : <><IndexPanel projectId={projectId} index={index} onReload={reload} /><ExtractPanel projectId={projectId} sources={sources} candidates={candidates} onReload={reload} /><QueryPanel projectId={projectId} indexReady={index.activeIndex !== null && index.compatible} answers={answers} onReload={reload} /></>}</div></main>;
}

function ConsentCheck({ checked, setChecked }: { checked: boolean; setChecked: (value: boolean) => void }) {
  return <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} className="mt-0.5" /><span>我确认本次所选资料、检索问题及命中的证据片段会发送给项目路由中选择的模型供应商处理；不会发送未命中的完整项目库。</span></label>;
}

function MemoryIndexConsentCheck({
  checked,
  setChecked,
  plan,
}: {
  checked: boolean;
  setChecked: (value: boolean) => void;
  plan: IndexPlan | null;
}) {
  const modeLabel = plan?.mode === "incremental" ? "增量" : "全量";
  const details = plan === null
    ? "请先读取当前索引计划。"
    : `${modeLabel}构建将使用 ${plan.providerName} 的 ${plan.modelId}（${plan.dimensions} 维），待生成 ${plan.generateCount} 条、复用 ${plan.reuseCount} 条，预计 ${plan.estimatedProviderCalls} 次向量请求。所有待生成片段会发送给该供应商；复用片段不会再次外发。`;
  return <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={checked} disabled={plan === null} onChange={(event) => setChecked(event.target.checked)} className="mt-0.5" /><span>我确认本次索引构建的传输范围：{details}</span></label>;
}

function IndexPanel({ projectId, index, onReload }: { projectId: string; index: IndexStatus; onReload: () => Promise<IndexStatus | null> }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"full" | "incremental">("full");
  const [plan, setPlan] = useState<IndexPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    if (!index.route) { setPlan(null); return; }
    setAcknowledged(false);
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

  async function build() {
    if (plan === null || !plan.deadlineEligible || plan.ineligibleCode !== null) {
      setMessage("当前索引计划不可执行，请重新读取计划或先建立全量基线");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: crypto.randomUUID(), mode, planFingerprint: plan.planFingerprint, consent }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        if (response.status === 409 && payload?.error?.code === "MEMORY_INDEX_PLAN_STALE") {
          setAcknowledged(false);
          await loadPlan();
          setMessage("索引输入或路由已变化，计划已刷新；请重新确认后再构建，不会自动重试保存。");
          return;
        }
        throw new Error(payload?.error?.message ?? "索引构建失败");
      }
      const payload = await response.json() as { job: { status: string; result?: { indexGenerationId?: string } } };
      const refreshed = await onReload();
      const activeGenerationId = refreshed?.activeIndex?.generation.id;
      const switched = payload.job.status === "succeeded" &&
        payload.job.result?.indexGenerationId !== undefined &&
        activeGenerationId === payload.job.result.indexGenerationId &&
        refreshed?.activeIndex?.generation.status === "complete";
      setMessage(switched
        ? "新索引已完成并原子切换"
        : payload.job.status === "succeeded"
          ? "任务已完成，但活动索引已发生变化；请以当前索引状态为准"
          : `索引任务状态：${payload.job.status}，旧索引保持不变`);
    } catch (buildError) {
      setMessage(buildError instanceof Error ? buildError.message : "索引构建失败");
    } finally {
      setAcknowledged(false);
      setPending(false);
    }
  }

  async function reconcile() {
    if (!index.latestJob || index.latestJob.status !== "unknown" || !index.latestJob.reconciliationRequired) return;
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
    finally { setPending(false); }
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

  const changeMode = (nextMode: "full" | "incremental") => { setMode(nextMode); setAcknowledged(false); setPlan(null); };
  return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Unified vector memory</p><h2 className="mt-2 text-2xl font-semibold">项目语义索引</h2><p className="mt-2 text-sm leading-6 text-slate-500">使用当前冻结的人工资料、仓库资料生成和项目代码快照。失败或未知不会替换上一个可用索引。</p></div><div className="grid grid-cols-3 gap-2"><Metric label="资料" value={index.inputs.projectSourceCount} /><Metric label="代码" value={index.inputs.hasCodeSnapshot ? "已冻结" : "无"} /><Metric label="仓库资料" value={index.inputs.repositoryMaterialGenerationCount} /></div></div>{index.activeIndex ? <div className={`mt-6 rounded-2xl border p-5 ${ready ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={`text-sm font-semibold ${ready ? "text-emerald-900" : "text-amber-900"}`}>{readinessLabels[index.readiness]} · {index.activeIndex.generation.recordCount} 条记忆</p><p className={`mt-1 text-xs ${ready ? "text-emerald-700" : "text-amber-700"}`}>索引：{index.activeIndex.generation.providerConnection.name} · {index.activeIndex.generation.modelId} · {index.activeIndex.generation.dimensions} 维 · {dateLabel(index.activeIndex.publishedAt)}</p><p className={`mt-1 text-xs ${ready ? "text-emerald-700" : "text-amber-700"}`}>当前路由：{index.route ? `${index.route.providerConnection.name} · ${index.route.modelId} · ${index.route.embeddingDimensions ?? "未知"} 维` : "未配置"}</p></div><code className={`text-[10px] ${ready ? "text-emerald-700" : "text-amber-700"}`}>{index.activeIndex.generation.inputManifestFingerprint.slice(0, 16)}…</code></div>{!ready ? <p className="mt-3 text-xs leading-5 text-amber-800">{index.readiness === "providerUnavailable" ? "当前向量供应商未通过连接测试或已停用，语义查询和项目智能体已暂停。" : index.readiness === "legacyIndex" ? "这是旧版索引格式，升级后需首次全量重建；重建前语义查询和项目智能体保持暂停。" : index.readiness === "inputsChanged" ? "资料或仓库快照已变化，旧索引不会混用新输入；请重建后恢复语义能力。" : "当前向量供应商、模型或维度与该索引不一致，重建前已停用语义查询和项目智能体。"}</p> : null}</div> : <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">{readinessLabels[index.readiness]}</div>}{index.latestJob?.status === "unknown" && index.latestJob.reconciliationRequired ? <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><p>上一次索引请求结果未知，不能自动重试模型。</p><button type="button" onClick={() => void reconcile()} disabled={pending} className="mt-3 rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold">人工收口未知结果</button></div> : null}{!index.route ? <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">请先在 <Link href={`/projects/${projectId}/control`} className="font-semibold underline">智能控制台</Link> 配置语义向量路由。</p> : <><div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold text-slate-700">选择构建方式</p><div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600"><label className="flex items-center gap-2"><input type="radio" name="memory-index-mode" checked={mode === "full"} onChange={() => changeMode("full")} />全量构建（不复用旧向量）</label><label className="flex items-center gap-2"><input type="radio" name="memory-index-mode" checked={mode === "incremental"} onChange={() => changeMode("incremental")} />增量构建（仅复用兼容向量）</label></div>{planLoading ? <p className="mt-3 text-xs text-slate-500">正在计算当前计划…</p> : plan ? <p className="mt-3 text-xs leading-5 text-slate-500">当前路由：{plan.providerName} · {plan.modelId} · {plan.dimensions} 维；输入 {plan.expectedInputCount} 条，需生成 {plan.generateCount} 条，复用 {plan.reuseCount} 条，删除 {plan.deleteCount} 条。{plan.ineligibleCode === "MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED" ? "当前没有可复用的兼容全量基线，请先执行全量构建。" : !plan.deadlineEligible ? "规模无法在一次请求期限内安全完成。" : "计划可执行，确认后才会发送选中内容。"}</p> : null}</div><MemoryIndexConsentCheck checked={acknowledged} setChecked={setAcknowledged} plan={plan} /><button type="button" onClick={() => void build()} disabled={!acknowledged || pending || planLoading || plan === null || !plan.deadlineEligible || plan.ineligibleCode !== null} className="mt-4 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? "分批嵌入并发布中…" : index.activeIndex ? `${mode === "full" ? "全量重建" : "增量重建"}并切换索引` : "建立语义索引"}</button></>}{message ? <p role="status" className="mt-3 text-sm text-slate-600">{message}</p> : null}</section>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div className="min-w-20 rounded-xl bg-slate-50 px-3 py-3 text-center"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>; }

function ExtractPanel({ projectId, sources, candidates, onReload }: { projectId: string; sources: Source[]; candidates: Candidate[]; onReload: () => Promise<unknown> }) {
  const [selected, setSelected] = useState<string[]>([]); const [acknowledged, setAcknowledged] = useState(false); const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null); const pendingCandidates = candidates.filter((candidate) => candidate.reviewStatus === "candidate");
  function toggle(sourceId: string) { setSelected((current) => current.includes(sourceId) ? current.filter((id) => id !== sourceId) : current.length < 10 ? [...current, sourceId] : current); }
  async function extract() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: crypto.randomUUID(), sourceIds: selected, consent }),
      });
      if (!response.ok) throw new Error(await readError(response, "自动抽取失败"));
      const payload = await response.json() as { job?: { result?: {
        candidateCount?: number;
        duplicateCount?: number;
        returnedCandidateCount?: number;
        rejectedCandidateCount?: number;
        recoveredExcerptCount?: number;
        anchoredExcerptCount?: number;
      } | null } };
      const result = payload.job?.result;
      const created = result?.candidateCount ?? 0;
      const duplicates = result?.duplicateCount ?? 0;
      const returned = result?.returnedCandidateCount ?? created + duplicates;
      const rejected = result?.rejectedCandidateCount ?? 0;
      const recovered = result?.recoveredExcerptCount ?? 0;
      const anchored = result?.anchoredExcerptCount ?? 0;
      setSelected([]);
      if (returned > 0 && created === 0 && duplicates === 0 && rejected > 0) {
        setMessage(`供应商调用成功并返回 ${returned} 条，但 ${rejected} 条既未引用有效证据块，也不是原文中的连续摘录，因此系统未写入候选。建议一次只选 1 条较短资料重试，或在智能控制台切换生成模型。`);
      } else if (returned === 0) {
        setMessage("供应商调用成功，但模型未发现有充分原文证据的决策、进展、问题或风险；本次未生成候选。可换一条资料或缩小范围后重试。");
      } else {
        const details = [`新增 ${created} 条待审核候选`];
        if (rejected > 0) details.push(`跳过 ${rejected} 条无有效证据定位的输出`);
        if (anchored > 0) details.push(`通过证据块定位 ${anchored} 条原文`);
        if (recovered > 0) details.push(`校正 ${recovered} 条仅有空白差异的摘录`);
        if (duplicates > 0) details.push(`忽略 ${duplicates} 条重复候选`);
        setMessage(`${details.join("；")}。候选仍须逐条人工确认才会进入已确认记忆。`);
      }
      await onReload();
    } catch (extractError) {
      setMessage(extractError instanceof Error ? extractError.message : "自动抽取失败");
    } finally {
      setAcknowledged(false);
      setPending(false);
    }
  }
  async function review(candidate: Candidate, action: "accept" | "dismiss") { setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/memory/candidates/${candidate.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, expectedItemUpdatedAt: candidate.projectItem.updatedAt }) }); if (!response.ok) throw new Error(await readError(response, "候选审核失败")); await onReload(); } catch (reviewError) { setMessage(reviewError instanceof Error ? reviewError.message : "候选审核失败"); } }
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Grounded extraction</p><h2 className="mt-2 text-2xl font-semibold">自动抽取与人工审核</h2><p className="mt-2 text-sm leading-6 text-slate-500">每个候选都必须带有原文中的精确连续摘录。系统会逐条校验：有效候选继续进入人工审核，无法回溯的条目单独跳过，不再拖垮整批结果。</p></div><div className="mt-6 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]"><div className="min-w-0"><h3 className="text-sm font-semibold">选择资料（最多 10 条）</h3><div className="mt-3 max-h-72 min-w-0 max-w-full space-y-2 overflow-auto">{sources.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">还没有项目资料。</p> : sources.map((source) => <label key={source.id} className="flex min-w-0 max-w-full cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-xs"><input type="checkbox" checked={selected.includes(source.id)} onChange={() => toggle(source.id)} className="mt-0.5 shrink-0" /><span className="min-w-0 max-w-full"><span className="block font-semibold text-slate-700">{source.kind} · {source.originScope === "project" ? "项目资料" : "仓库资料"}</span><span className="mt-1 block text-slate-400 [overflow-wrap:anywhere]">{source.externalRef ?? source.contentHash}</span></span></label>)}</div><ConsentCheck checked={acknowledged} setChecked={setAcknowledged} /><button type="button" onClick={() => void extract()} disabled={pending || !acknowledged || selected.length === 0} className="mt-4 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? "逐条分析并校验原文中…" : `抽取 ${selected.length} 条资料`}</button></div><div className="min-w-0"><div className="flex min-w-0 items-center justify-between gap-2"><h3 className="text-sm font-semibold">待审核候选</h3><span className="shrink-0 text-xs text-slate-400">{pendingCandidates.length} 条</span></div>{pendingCandidates.length === 0 ? <p className="mt-3 min-w-0 max-w-full rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">暂无待审核候选。</p> : <div className="mt-3 min-w-0 max-w-full space-y-3">{pendingCandidates.map((candidate) => <article key={candidate.id} className="min-w-0 max-w-full rounded-2xl border border-slate-200 p-5"><div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">{candidate.projectItem.type}</span><span className="min-w-0 text-[11px] text-slate-400 [overflow-wrap:anywhere]">{candidate.providerConnection.name} · {candidate.modelId}</span></div><h4 className="mt-3 [overflow-wrap:anywhere] font-semibold">{candidate.projectItem.title}</h4><p className="mt-2 text-sm leading-6 text-slate-600 [overflow-wrap:anywhere]">{candidate.projectItem.content}</p><blockquote className="mt-4 border-l-2 border-indigo-200 pl-3 text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">{candidate.projectItem.sourceExcerpt}</blockquote><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void review(candidate, "accept")} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white">确认记忆</button><button type="button" onClick={() => void review(candidate, "dismiss")} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">驳回</button></div></article>)}</div>}</div></div>{message ? <p role="status" className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}</section>;
}

function QueryPanel({ projectId, indexReady, answers, onReload }: { projectId: string; indexReady: boolean; answers: Answer[]; onReload: () => Promise<unknown> }) {
  const [question, setQuestion] = useState(""); const [acknowledged, setAcknowledged] = useState(false); const [pending, setPending] = useState<"search" | "answer" | null>(null); const [message, setMessage] = useState<string | null>(null); const [results, setResults] = useState<SearchResult[]>([]);
  async function run(mode: "search" | "answer", event?: FormEvent) { event?.preventDefault(); setPending(mode); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/memory/${mode === "search" ? "search" : "answers"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientKey: crypto.randomUUID(), question, consent }) }); if (!response.ok) throw new Error(await readError(response, mode === "search" ? "语义检索失败" : "引用式问答失败")); const payload = await response.json() as { job: { result?: { results?: SearchResult[] } } }; if (mode === "search") setResults(payload.job.result?.results ?? []); else { await onReload(); setMessage("回答已生成并保存；每条引用都来自当前索引。 "); } } catch (runError) { setMessage(runError instanceof Error ? runError.message : "请求失败"); } finally { setAcknowledged(false); setPending(null); } }
  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Semantic search & grounded RAG</p><h2 className="mt-2 text-2xl font-semibold">检索与引用式问答</h2><p className="mt-2 text-sm leading-6 text-slate-500">语义分数与关键词分数混合排序；生成回答只能引用本次检索命中的记录 ID。</p></div><form onSubmit={(event) => void run("answer", event)} className="mt-6"><label className="text-sm font-semibold" htmlFor="memory-question">你想了解什么？</label><textarea id="memory-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={2000} required className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" placeholder="例如：当前项目最重要的技术风险是什么？哪些代码和资料支持这个判断？" /><ConsentCheck checked={acknowledged} setChecked={setAcknowledged} /><div className="mt-4 flex gap-3"><button type="button" onClick={() => void run("search")} disabled={!indexReady || !question.trim() || !acknowledged || pending !== null} className="rounded-xl border border-indigo-200 px-5 py-3 text-sm font-semibold text-indigo-700 disabled:opacity-40">{pending === "search" ? "检索中…" : "仅做语义检索"}</button><button disabled={!indexReady || !question.trim() || !acknowledged || pending !== null} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending === "answer" ? "检索并生成中…" : "生成带引用回答"}</button></div></form>{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}{results.length > 0 ? <div className="mt-7"><h3 className="text-sm font-semibold">语义检索结果</h3><div className="mt-3 space-y-3">{results.map((result, index) => <article key={result.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><div className="flex items-center justify-between gap-4"><span className="text-xs font-semibold text-indigo-700">#{index + 1} · {result.scope}{result.path ? ` · ${result.path}` : ""}</span><span className="text-xs text-slate-400">综合 {result.score.toFixed(3)}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{result.contentText}</p></article>)}</div></div> : null}<div className="mt-9 border-t border-slate-100 pt-7"><h3 className="text-sm font-semibold">回答历史</h3>{answers.length === 0 ? <p className="mt-3 text-sm text-slate-500">还没有引用式回答。</p> : <div className="mt-3 space-y-5">{answers.map((answer) => <article key={answer.id} className="rounded-2xl border border-slate-200 p-6"><p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">{answer.question}</p><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">{answer.answer}</p><div className="mt-5 space-y-2 border-t border-slate-100 pt-4"><p className="text-xs font-semibold text-slate-500">引用证据</p>{Array.isArray(answer.citations) ? answer.citations.map((citation) => <details key={citation.id} className="rounded-xl bg-slate-50 px-4 py-3"><summary className="cursor-pointer text-xs font-medium text-slate-600">{citation.scope}{citation.path ? ` · ${citation.path}` : ""}{citation.frozenCommitSha ? ` @ ${citation.frozenCommitSha.slice(0, 8)}` : ""}</summary><blockquote className="mt-3 border-l-2 border-indigo-200 pl-3 text-xs leading-5 text-slate-500">{citation.excerpt}</blockquote></details>) : null}</div><p className="mt-4 text-[11px] text-slate-400">{answer.providerConnection.name} · {answer.modelId} · {dateLabel(answer.createdAt)}</p></article>)}</div>}</div></section>;
}
