"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";

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
  status: "on_track" | "needs_attention" | "at_risk" | "unknown";
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
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputManifestFingerprint: string;
  createdAt: string;
  providerConnection: { name: string; kind: string };
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
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputManifestFingerprint: string;
  createdAt: string;
  providerConnection: { name: string; kind: string };
};
type ProviderRoute = null | {
  operation: "embedding" | "generateWithContext";
  modelId: string;
  embeddingDimensions?: number | null;
  providerConnection: { id: string; name: string; kind: string; status: string };
};
type Readiness = {
  activeIndex: boolean;
  indexCompatible: boolean;
  embeddingRoute: boolean;
  generationRoute: boolean;
  ready: boolean;
  indexGenerationId: string | null;
  routes: { embedding: ProviderRoute; generation: ProviderRoute };
};
type StatusPayload = {
  reports: Report[];
  agentRuns: AgentRun[];
  tools: ToolTrace["tool"][];
  readiness: Readiness;
};

const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;
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
  try {
    return ((await response.json()) as { error?: { message?: string } }).error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function ProjectIntelligenceClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("项目");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="intelligence" />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <section className="pb-10 pt-12">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Project intelligence agent</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{projectName}</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">智能体先制定受约束的只读调查计划，再读取项目概览、已确认事实、语义记忆和仓库状态。回答必须引用本次调查实际取得的证据，不具备代码、GitHub 或系统写入能力。</p>
        </section>

        {error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {loading || status === null ? <div className="h-48 animate-pulse rounded-3xl bg-slate-200" aria-label="正在加载项目智能体" /> : (
          <>
            <ReadinessPanel readiness={status.readiness} />
            <BriefPanel projectId={projectId} report={status.reports[0] ?? null} ready={status.readiness.ready} onReload={reload} />
            <AgentPanel projectId={projectId} runs={status.agentRuns} tools={status.tools} ready={status.readiness.ready} onReload={reload} />
          </>
        )}
      </div>
    </main>
  );
}

function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  const checks = [
    { label: "生成模型路由", ready: readiness.generationRoute, detail: readiness.routes.generation ? `${readiness.routes.generation.providerConnection.name} · ${readiness.routes.generation.modelId}` : "尚未配置" },
    { label: "向量模型路由", ready: readiness.embeddingRoute, detail: readiness.routes.embedding ? `${readiness.routes.embedding.providerConnection.name} · ${readiness.routes.embedding.modelId}` : "尚未配置" },
    { label: "兼容的记忆索引", ready: readiness.indexCompatible, detail: readiness.indexCompatible ? `索引 ${shortHash(readiness.indexGenerationId ?? "")}` : readiness.activeIndex ? "当前向量路由已变化，请重建索引" : "尚未建立" },
  ];
  return <section className={`rounded-3xl border p-6 shadow-sm ${readiness.ready ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Runtime readiness</p><h2 className="mt-2 text-xl font-semibold">{readiness.ready ? "项目智能体已就绪" : "完成配置后即可运行"}</h2></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${readiness.ready ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{readiness.ready ? "READY" : "SETUP REQUIRED"}</span></div><div className="mt-5 grid gap-3 md:grid-cols-3">{checks.map((check) => <div key={check.label} className="rounded-2xl border border-white/80 bg-white/80 p-4"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${check.ready ? "bg-emerald-500" : "bg-amber-400"}`} /><p className="text-sm font-semibold">{check.label}</p></div><p className="mt-2 truncate text-xs text-slate-500" title={check.detail}>{check.detail}</p></div>)}</div>{!readiness.ready ? <p className="mt-4 text-xs leading-5 text-amber-900">请在“智能控制台”配置并验证生成、向量路由，再到“智能记忆”建立当前索引。项目内容只有在你勾选本次确认并主动运行后才会发送给供应商。</p> : null}</section>;
}

function ConsentCheck({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5" /><span>我确认本次项目概览、已确认条目、仓库状态、问题和命中的记忆片段会发送给页面所选模型供应商；不会发送未命中的完整项目库，也不会执行任何写入。</span></label>;
}

function BriefPanel({ projectId, report, ready, onReload }: { projectId: string; report: Report | null; ready: boolean; onReload: () => Promise<void> }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function generate() {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: crypto.randomUUID(), consent }),
      });
      if (!response.ok) throw new Error(await readError(response, "项目简报生成失败"));
      setMessage("当前状态简报已生成并保存"); await onReload();
    } catch (generateError) {
      setMessage(generateError instanceof Error ? generateError.message : "项目简报生成失败");
    } finally {
      setAcknowledged(false);
      setPending(false);
    }
  }

  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="flex flex-wrap items-start justify-between gap-5 border-b border-slate-100 pb-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Current state brief</p><h2 className="mt-2 text-2xl font-semibold">项目当前状态</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">聚合已确认条目、当前索引和仓库状态，生成可追溯的进展、决策、问题、风险与关注事项。</p></div><button type="button" onClick={() => void generate()} disabled={!ready || !acknowledged || pending} className="rounded-xl bg-indigo-600 px-5 py-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{pending ? "调查与生成中…" : report ? "重新生成简报" : "生成当前状态简报"}</button></div><ConsentCheck checked={acknowledged} onChange={setAcknowledged} />{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}{report ? <ReportView report={report} /> : <div className="mt-6 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-500">还没有项目智能简报。运行后，结果与证据快照会固定保存。</div>}</section>;
}

function ReportView({ report }: { report: Report }) {
  const citationNumbers = useMemo(() => new Map(report.citations.map((citation, index) => [citation.id, index + 1])), [report.citations]);
  const statusStyle = { on_track: "bg-emerald-100 text-emerald-700", needs_attention: "bg-amber-100 text-amber-800", at_risk: "bg-rose-100 text-rose-700", unknown: "bg-slate-100 text-slate-600" }[report.report.status];
  const statusLabel = { on_track: "进展正常", needs_attention: "需要关注", at_risk: "存在风险", unknown: "证据不足" }[report.report.status];
  return <div className="mt-7"><div className="rounded-2xl bg-slate-950 p-6 text-white"><div className="flex flex-wrap items-center justify-between gap-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle}`}>{statusLabel}</span><span className="text-xs text-slate-400">{formatDate(report.createdAt)} · {report.providerConnection.name} / {report.modelId}</span></div><h3 className="mt-5 text-2xl font-semibold">{report.report.headline}</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-300">{report.report.summary}</p><CitationChips ids={report.report.citations} numbers={citationNumbers} /></div><div className="mt-6 grid gap-4 lg:grid-cols-2">{reportSections.map((section) => <ObservationSection key={section.key} title={section.label} observations={report.report[section.key]} numbers={citationNumbers} />)}</div><EvidenceList citations={report.citations} /><RunMeta inputTokens={report.inputTokens} outputTokens={report.outputTokens} fingerprint={report.inputManifestFingerprint} /></div>;
}

function AgentPanel({ projectId, runs, tools, ready, onReload }: { projectId: string; runs: AgentRun[]; tools: ToolTrace["tool"][]; ready: boolean; onReload: () => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/intelligence/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: crypto.randomUUID(), question, consent }),
      });
      if (!response.ok) throw new Error(await readError(response, "项目调查失败"));
      setQuestion(""); setSelectedRunId(null); setMessage("只读调查已完成"); await onReload();
    } catch (askError) {
      setMessage(askError instanceof Error ? askError.message : "项目调查失败");
    } finally {
      setAcknowledged(false);
      setPending(false);
    }
  }

  return <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8"><div className="border-b border-slate-100 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Read-only investigation</p><h2 className="mt-2 text-2xl font-semibold">向项目智能体提问</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">模型只能从固定工具中规划调查；服务端逐项校验并执行只读查询，最终回答只能引用本次工具取得的证据。</p><div className="mt-4 flex flex-wrap gap-2">{tools.map((tool) => <span key={tool} className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">{toolLabels[tool]}</span>)}</div></div><form onSubmit={ask} className="mt-6"><label className="block text-sm font-semibold text-slate-700">你想了解什么？<textarea value={question} onChange={(event) => setQuestion(event.target.value)} minLength={2} maxLength={2_000} rows={4} placeholder="例如：目前最需要关注的风险是什么？哪些关键决策仍缺少证据？" className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 outline-none transition focus:border-indigo-400 focus:bg-white" /></label><ConsentCheck checked={acknowledged} onChange={setAcknowledged} /><div className="mt-4 flex items-center justify-between gap-4"><p className="text-xs text-slate-500">不提供 Shell、文件系统、代码修改或 GitHub 写入工具。</p><button disabled={!ready || !acknowledged || pending || question.trim().length < 2} className="shrink-0 rounded-xl bg-slate-950 px-5 py-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{pending ? "规划与调查中…" : "开始只读调查"}</button></div></form>{message ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{message}</p> : null}{runs.length > 1 ? <div className="mt-7 flex gap-2 overflow-x-auto pb-2">{runs.slice(0, 10).map((run) => <button key={run.id} type="button" onClick={() => setSelectedRunId(run.id)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-semibold ${selectedRun?.id === run.id ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>{formatDate(run.createdAt)}</button>)}</div> : null}{selectedRun ? <AgentRunView run={selectedRun} /> : <div className="mt-7 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-sm text-slate-500">还没有调查记录。每次计划、工具轨迹和证据引用都会随回答保存。</div>}</section>;
}

function AgentRunView({ run }: { run: AgentRun }) {
  const citationNumbers = useMemo(() => new Map(run.citations.map((citation, index) => [citation.id, index + 1])), [run.citations]);
  return <article className="mt-7"><div className="rounded-2xl border border-slate-200 bg-slate-50 p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Question</p><h3 className="mt-2 text-lg font-semibold">{run.question}</h3><p className="mt-2 text-xs text-slate-500">{formatDate(run.createdAt)} · {run.providerConnection.name} / {run.modelId}</p></div><div className="mt-4 rounded-2xl bg-slate-950 p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Grounded answer</p><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-200">{run.answer}</p><CitationChips ids={run.citations.map((citation) => citation.id)} numbers={citationNumbers} /></div>{run.recommendations.length > 0 ? <ObservationSection title="建议" observations={run.recommendations} numbers={citationNumbers} /> : null}{run.uncertainties.length > 0 ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h4 className="text-sm font-semibold text-amber-900">证据不足与不确定性</h4><ul className="mt-3 space-y-2 text-sm leading-6 text-amber-900">{run.uncertainties.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul></div> : null}<ToolTraceView objective={run.plan.objective} trace={run.trace} /><EvidenceList citations={run.citations} /><RunMeta inputTokens={run.inputTokens} outputTokens={run.outputTokens} fingerprint={run.inputManifestFingerprint} /></article>;
}

function ObservationSection({ title, observations, numbers }: { title: string; observations: Observation[]; numbers: ReadonlyMap<string, number> }) {
  return <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"><h4 className="text-sm font-semibold text-slate-800">{title}</h4>{observations.length === 0 ? <p className="mt-3 text-sm text-slate-400">暂无可验证内容</p> : <ul className="mt-3 space-y-4">{observations.map((observation, index) => <li key={`${index}-${observation.text}`} className="text-sm leading-6 text-slate-600"><p>{observation.text}</p><CitationChips ids={observation.citations} numbers={numbers} /></li>)}</ul>}</section>;
}

function CitationChips({ ids, numbers }: { ids: string[]; numbers: ReadonlyMap<string, number> }) {
  return <span className="mt-3 flex flex-wrap gap-1.5">{[...new Set(ids)].map((id) => <span key={id} title={id} className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">证据 {numbers.get(id) ?? "?"}</span>)}</span>;
}

function EvidenceList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return <section className="mt-6 rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold">证据快照</h4><div className="mt-4 divide-y divide-slate-100">{citations.map((citation, index) => <details key={citation.id} className="py-3"><summary className="cursor-pointer list-none text-sm font-medium text-slate-700"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{index + 1}</span>{citation.label}<span className="ml-2 text-xs font-normal text-slate-400">{citation.kind}</span></summary><div className="ml-8 mt-3 text-xs leading-5 text-slate-500"><p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-slate-600">{citation.excerpt}</p>{citation.path ? <p className="mt-2">路径：{citation.path}</p> : null}{citation.externalRef ? <p className="mt-1 break-all">来源：{citation.externalRef}</p> : null}{citation.frozenCommitSha ? <p className="mt-1 font-mono">冻结 commit：{citation.frozenCommitSha}</p> : null}<p className="mt-1 font-mono">SHA-256：{citation.contentHash}</p></div></details>)}</div></section>;
}

function ToolTraceView({ objective, trace }: { objective: string; trace: ToolTrace[] }) {
  return <section className="mt-6 rounded-2xl border border-slate-200 p-5"><h4 className="text-sm font-semibold">只读调查轨迹</h4><p className="mt-2 text-sm leading-6 text-slate-500">目标：{objective}</p><ol className="mt-4 space-y-3">{trace.map((entry, index) => <li key={`${index}-${entry.tool}`} className="flex items-start gap-3 rounded-xl bg-slate-50 p-4"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">{index + 1}</span><div><p className="text-sm font-semibold">{toolLabels[entry.tool]}</p><p className="mt-1 text-xs text-slate-500">返回 {entry.resultCount} 条证据 · 参数 {JSON.stringify(entry.arguments)}</p></div></li>)}</ol></section>;
}

function RunMeta({ inputTokens, outputTokens, fingerprint }: { inputTokens: number; outputTokens: number; fingerprint: string }) {
  return <p className="mt-4 text-[11px] leading-5 text-slate-400">输入 {inputTokens} tokens · 输出 {outputTokens} tokens · 输入清单 {shortHash(fingerprint)}</p>;
}
