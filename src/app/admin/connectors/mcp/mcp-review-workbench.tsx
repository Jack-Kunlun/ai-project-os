"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AdminPageHeader } from "@/components/admin-page-header";

type ReviewState = "eligible" | "active";
type ReviewConclusion = "read_only_verified" | "read_only_rejected" | "needs_research";
type ReviewRiskLevel = "low" | "medium" | "high";
type ReviewRiskReasonCode =
  | "read_only_eligible"
  | "write_capability"
  | "destructive_capability"
  | "untrusted_remote_text"
  | "schema_invalid"
  | "network_unverified"
  | "credential_scope_unknown"
  | "insufficient_evidence";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type McpCandidate = Readonly<{
  state: ReviewState;
  reviewStatus?: "approved" | "unreviewed";
  effective?: boolean;
  effectiveReason?: string | null;
  requiresRevocation?: boolean;
  blockingAttestationId?: string;
  status?: string | null;
  version?: number | null;
  conclusion?: string | null;
  riskLevel?: ReviewRiskLevel | null;
  connection: Readonly<{ id: string; name: string | null }>;
  tool: Readonly<{
    id: string;
    name: string;
    title: string | null;
    description: string | null;
    inputSchema: JsonValue;
    outputSchema: JsonValue;
    annotations: JsonValue;
    remoteTextTrust: "untrusted";
    definitionFingerprint: string;
    remoteReadOnlyHint?: boolean;
  }>;
  snapshots: Readonly<{
    connectionConfigurationRevision: number | null;
    connectionUpdatedAt: string;
    connectionOwnerAccountAccessVersion: number | null;
    definitionFingerprint: string;
    networkFingerprint: string;
    credentialFingerprint: string;
  }>;
}>;

type CandidateList = Readonly<{
  state: ReviewState;
  page: number;
  pageSize: number;
  total: number;
  candidates: McpCandidate[];
}>;

type StatusKey = "eligible" | "active" | "stale" | "revocationRequired";

const PAGE_SIZE = 20;
const statusLabels: Readonly<Record<StatusKey, string>> = {
  eligible: "待审核候选",
  active: "当前有效 V2",
  stale: "快照已失效",
  revocationRequired: "需要先撤销旧证据",
};
const statusClasses: Readonly<Record<StatusKey, string>> = {
  eligible: "bg-amber-50 text-amber-700",
  active: "bg-emerald-50 text-emerald-700",
  stale: "bg-rose-50 text-rose-700",
  revocationRequired: "bg-violet-50 text-violet-700",
};
const conclusionLabels: Readonly<Record<ReviewConclusion, string>> = {
  read_only_verified: "确认只读",
  read_only_rejected: "拒绝只读认证",
  needs_research: "需要进一步研究",
};
const riskLabels: Readonly<Record<ReviewRiskLevel, string>> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};
const riskReasonLabels: Readonly<Record<ReviewRiskReasonCode, string>> = {
  read_only_eligible: "声明为只读候选",
  write_capability: "发现写入能力",
  destructive_capability: "发现破坏性能力",
  untrusted_remote_text: "远端文本不可信",
  schema_invalid: "Schema 不符合要求",
  network_unverified: "网络快照未确认",
  credential_scope_unknown: "凭据范围未知",
  insufficient_evidence: "证据不足",
};
const effectiveReasonLabels: Readonly<Record<string, string>> = {
  v2_shape_invalid: "V2 证据结构不符合当前不变量",
  verifier_not_admin: "审核人已不再具备管理员资格",
  verifier_disabled: "原审核人账号已停用",
  tool_definition_stale: "工具定义已经不是当前版本",
  tool_not_read_only: "工具不再满足只读声明",
  connection_not_verified: "连接或所有者状态已变化",
  snapshot_drift: "定义、网络、凭据或配置版本已变化",
  review_required: "当前 V2 证据尚未关联不可变正向审核",
};

const reviewNoteUnsafePattern = /(?:https?:\/\/|ftp:\/\/|www\.|authorization|cookie|header|bearer\s+|basic\s+|token|secret|password|private[\s_-]*key|[A-Za-z0-9+/=_-]{32,})/iu;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "时间不可用";
}

function safeValue(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function statusKeys(candidate: McpCandidate): StatusKey[] {
  const values: StatusKey[] = [];
  if (candidate.state === "eligible") values.push("eligible");
  if (candidate.state === "active" && candidate.effective !== false) values.push("active");
  if (candidate.effective === false) values.push("stale");
  if (candidate.requiresRevocation === true) values.push("revocationRequired");
  return values.length > 0 ? values : [candidate.state];
}

function effectiveReason(candidate: McpCandidate): string | null {
  if (candidate.effectiveReason === null || candidate.effectiveReason === undefined) return null;
  return effectiveReasonLabels[candidate.effectiveReason] ?? "当前快照未通过有效性复核";
}

function schemaText(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[无法展示的净化结构]";
  }
}

function normalizeReviewNote(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0
    || Array.from(normalized).length > 240
    || controlCharacterPattern.test(normalized)
    || reviewNoteUnsafePattern.test(normalized)
  ) {
    throw new Error("审核说明只能记录不含地址、凭据或长指纹的简短判断。");
  }
  return normalized;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function StatusBadges({ candidate }: { candidate: McpCandidate }) {
  return <div className="flex flex-wrap gap-2" aria-label="候选状态">
    {statusKeys(candidate).map((status) => <span key={status} className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusClasses[status]}`}>{statusLabels[status]}</span>)}
  </div>;
}

function SnapshotRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="rounded-2xl bg-slate-50 px-4 py-3">
    <dt className="text-xs font-semibold text-slate-500">{label}</dt>
    <dd className="mt-2 break-all font-mono text-xs leading-5 text-slate-800">{safeValue(value)}</dd>
  </div>;
}

function SchemaBlock({ label, value }: { label: string; value: JsonValue }) {
  return <details className="group rounded-2xl border border-slate-200 bg-slate-50">
    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">
      <span className="flex items-center justify-between gap-3"><span>{label}</span><span className="text-xs font-normal text-slate-500 group-open:text-indigo-600">展开净化结构</span></span>
    </summary>
    <pre className="max-h-[360px] overflow-auto border-t border-slate-200 px-4 py-4 font-mono text-xs leading-5 text-slate-700">{schemaText(value)}</pre>
  </details>;
}

function CandidateCard({ candidate, selected, onSelect }: { candidate: McpCandidate; selected: boolean; onSelect: () => void }) {
  return <article className={`rounded-2xl border bg-white transition ${selected ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}>
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="w-full rounded-2xl px-4 py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">{safeValue(candidate.tool.title) === "—" ? candidate.tool.name : candidate.tool.title}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{candidate.tool.name} · {safeValue(candidate.connection.name)}</p>
        </div>
        <StatusBadges candidate={candidate} />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-500">
        <span>配置版本 {safeValue(candidate.snapshots.connectionConfigurationRevision)}</span>
        <span>更新于 {formatDate(candidate.snapshots.connectionUpdatedAt)}</span>
      </div>
      {effectiveReason(candidate) ? <p className="mt-3 text-xs leading-5 text-rose-700">{effectiveReason(candidate)}</p> : null}
    </button>
  </article>;
}

function ReviewForm({ candidate, onCompleted }: { candidate: McpCandidate; onCompleted: (conclusion: ReviewConclusion) => void }) {
  const [conclusion, setConclusion] = useState<ReviewConclusion>("read_only_verified");
  const [riskLevel, setRiskLevel] = useState<ReviewRiskLevel>("low");
  const [riskReasonCode, setRiskReasonCode] = useState<ReviewRiskReasonCode>("read_only_eligible");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function changeConclusion(value: ReviewConclusion) {
    setConclusion(value);
    setRiskReasonCode(value === "read_only_verified" ? "read_only_eligible" : value === "read_only_rejected" ? "write_capability" : "insufficient_evidence");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const note = normalizeReviewNote(evidenceNote);
      const configurationRevision = candidate.snapshots.connectionConfigurationRevision;
      if (typeof configurationRevision !== "number" || !Number.isInteger(configurationRevision) || configurationRevision < 1) {
        throw new Error("当前配置版本不可用，请刷新候选后重试。");
      }
      const nextRequestKey = requestKey || `mcp-review:${candidate.tool.id}:${crypto.randomUUID()}`;
      setRequestKey(nextRequestKey);
      const response = await fetch("/api/system/mcp-tool-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: candidate.connection.id,
          toolDefinitionId: candidate.tool.id,
          expectedConnectionConfigurationRevision: configurationRevision,
          expectedConnectionUpdatedAt: candidate.snapshots.connectionUpdatedAt,
          expectedDefinitionFingerprint: candidate.snapshots.definitionFingerprint,
          expectedNetworkFingerprint: candidate.snapshots.networkFingerprint,
          expectedCredentialFingerprint: candidate.snapshots.credentialFingerprint,
          conclusion,
          riskLevel,
          riskReasonCode,
          evidenceNote: note,
          requestKey: nextRequestKey,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "MCP 工具审核提交失败"));
      setMessage(conclusion === "read_only_verified"
        ? "已记录只读审核，并创建当前 V2 平台审核证据。"
        : conclusion === "read_only_rejected"
          ? "已记录拒绝结论；未创建授权证据。"
          : "已记录待研究结论；未创建授权证据。");
      setEvidenceNote("");
      setRequestKey("");
      setConfirmed(false);
      onCompleted(conclusion);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "MCP 工具审核提交失败");
    } finally {
      setPending(false);
    }
  }

  return <form onSubmit={submit} className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-5 sm:p-6" aria-labelledby="mcp-review-form-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Review decision</p>
        <h3 id="mcp-review-form-title" className="mt-2 text-lg font-semibold text-slate-950">记录管理员审核</h3>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-600">服务端会再次核对候选快照、账号版本和 V2 不变量。本表单不会接收或读取个人连接材料。</p>
      </div>
      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">当前工具：{candidate.tool.name}</span>
    </div>

    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <label className="text-xs font-semibold text-slate-700">审核结论
        <select value={conclusion} onChange={(event) => changeConclusion(event.target.value as ReviewConclusion)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal text-slate-900 focus:border-indigo-400 focus:outline-2 focus:outline-indigo-100" disabled={pending}>
          {(Object.keys(conclusionLabels) as ReviewConclusion[]).map((value) => <option key={value} value={value}>{conclusionLabels[value]}</option>)}
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-700">风险等级
        <select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as ReviewRiskLevel)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal text-slate-900 focus:border-indigo-400 focus:outline-2 focus:outline-indigo-100" disabled={pending}>
          {(Object.keys(riskLabels) as ReviewRiskLevel[]).map((value) => <option key={value} value={value}>{riskLabels[value]}</option>)}
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-700 sm:col-span-2">风险原因
        <select value={riskReasonCode} onChange={(event) => setRiskReasonCode(event.target.value as ReviewRiskReasonCode)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal text-slate-900 focus:border-indigo-400 focus:outline-2 focus:outline-indigo-100" disabled={pending}>
          {(Object.keys(riskReasonLabels) as ReviewRiskReasonCode[]).map((value) => <option key={value} value={value}>{riskReasonLabels[value]}</option>)}
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-700 sm:col-span-2">审核说明（必填，最多 240 个字符）
        <textarea value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} maxLength={240} required rows={4} placeholder="例如：已核对工具输入输出结构，未发现破坏性动作。" className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal leading-6 text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-2 focus:outline-indigo-100" disabled={pending} />
      </label>
    </div>

    <label className="mt-5 flex items-start gap-3 rounded-2xl border border-indigo-100 bg-white px-4 py-3 text-xs leading-5 text-slate-700">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-indigo-600" disabled={pending} />
      <span>我确认审核内容只针对当前净化快照；提交只记录安全证据，不会触发远端操作。</span>
    </label>

    {error ? <p role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">{error}</p> : null}
    {message ? <p role="status" className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-700">{message}</p> : null}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-xs leading-5 text-slate-500">提交后保留追加式审核记录；正向结论才会关联当前 V2 只读证据。</p>
      <button type="submit" disabled={pending || !confirmed} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-200 disabled:text-slate-700">{pending ? "提交中…" : "提交审核结论"}</button>
    </div>
  </form>;
}

export function McpReviewWorkbench() {
  const [view, setView] = useState<ReviewState>("eligible");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CandidateList | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ state: view, page: String(page), pageSize: String(PAGE_SIZE) });
      const response = await fetch(`/api/system/mcp-tool-attestation-candidates?${params.toString()}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(await readError(response, "MCP 候选加载失败"));
      const payload = await response.json() as CandidateList;
      if (signal.aborted) return;
      setData(payload);
      setError(null);
      setSelectedId((current) => payload.candidates.some((candidate) => candidate.tool.id === current) ? current : payload.candidates[0]?.tool.id ?? "");
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      if (!signal.aborted) setError(loadError instanceof Error ? loadError.message : "MCP 候选加载失败");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [page, view]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, refreshToken]);

  const selectedCandidate = useMemo(() => data?.candidates.find((candidate) => candidate.tool.id === selectedId) ?? null, [data, selectedId]);
  const hasNextPage = data !== null && data.page * data.pageSize < data.total;

  function changeView(nextView: ReviewState) {
    setView(nextView);
    setPage(1);
    setData(null);
    setSelectedId("");
    setError(null);
  }

  function reviewCompleted(conclusion: ReviewConclusion) {
    setRefreshToken((value) => value + 1);
    if (conclusion === "read_only_verified" && view === "eligible") setSelectedId("");
  }

  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="MCP 工具安全审核" description="审核已经净化的工具快照；审核记录只表达受控结论，不开放远端工具操作。" meta="安全审核工作台" />
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-xs leading-5 text-indigo-950">远端 Schema 与 annotations 属于不可信远端声明，仅供人工审核，不能替代平台安全判断。</div>
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</div>
    </div>

    <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div role="tablist" aria-label="MCP 审核候选状态" className="flex flex-wrap gap-2">
        {([ ["eligible", "待审核候选"], ["active", "已审核快照"] ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={view === value} onClick={() => changeView(value)} className={`min-h-11 rounded-xl px-4 py-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${view === value ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>)}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">当前列表只返回净化后的连接名称、工具结构和安全指纹；服务端会对每次读取再次执行管理员校验。</p>
    </div>

    <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]">
      <section className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="mcp-candidate-list-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Candidate queue</p>
            <h2 id="mcp-candidate-list-title" className="mt-2 text-xl font-semibold text-slate-950">{view === "eligible" ? "待审核工具" : "当前 V2 审核记录"}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">{loading ? "正在读取安全快照…" : `${data?.total ?? 0} 条记录`}</p>
          </div>
          <button type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-200 disabled:text-slate-700">刷新</button>
        </div>
        {loading ? <div className="mt-5 space-y-3" role="status" aria-label="正在加载 MCP 审核候选"><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /></div> : error ? <div role="alert" className="mt-5 rounded-2xl bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-700">{error}</div> : data?.candidates.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">当前没有候选记录</p><p className="mt-2 text-xs leading-5 text-slate-500">可切换另一状态或稍后刷新安全快照。</p></div> : <div className="mt-5 space-y-3">{data?.candidates.map((candidate) => <CandidateCard key={candidate.tool.id} candidate={candidate} selected={candidate.tool.id === selectedId} onSelect={() => setSelectedId(candidate.tool.id)} />)}</div>}
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-200 disabled:text-slate-700">上一页</button>
          <span className="text-xs text-slate-500">第 {page} 页</span>
          <button type="button" onClick={() => setPage((value) => value + 1)} disabled={!hasNextPage || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-200 disabled:text-slate-700">下一页</button>
        </div>
      </section>

      <section className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="mcp-candidate-detail-title">
        {selectedCandidate ? <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Sanitized candidate detail</p>
              <h2 id="mcp-candidate-detail-title" className="mt-2 truncate text-xl font-semibold text-slate-950">{safeValue(selectedCandidate.tool.title) === "—" ? selectedCandidate.tool.name : selectedCandidate.tool.title}</h2>
              <p className="mt-1 truncate text-xs text-slate-500">{selectedCandidate.tool.name} · {safeValue(selectedCandidate.connection.name)}</p>
            </div>
            <StatusBadges candidate={selectedCandidate} />
          </div>
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">Schema、annotations 和远端描述均为不可信远端声明，仅供审核。这里展示的是服务端已净化结构，不代表平台已经信任其内容。</div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <SnapshotRow label="连接 ID" value={selectedCandidate.connection.id} />
            <SnapshotRow label="工具 ID" value={selectedCandidate.tool.id} />
            <SnapshotRow label="定义指纹" value={selectedCandidate.snapshots.definitionFingerprint} />
            <SnapshotRow label="网络指纹" value={selectedCandidate.snapshots.networkFingerprint} />
            <SnapshotRow label="凭据指纹" value={selectedCandidate.snapshots.credentialFingerprint} />
            <SnapshotRow label="配置版本" value={selectedCandidate.snapshots.connectionConfigurationRevision} />
            <SnapshotRow label="连接更新时间" value={formatDate(selectedCandidate.snapshots.connectionUpdatedAt)} />
            <SnapshotRow label="所有者账号版本" value={selectedCandidate.snapshots.connectionOwnerAccountAccessVersion} />
          </dl>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 px-4 py-3"><p className="text-xs font-semibold text-slate-500">只读能力</p><p className="mt-2 text-sm font-semibold text-slate-900">{selectedCandidate.state === "active" ? "已进入 V2 只读审核流" : "工具声明为只读候选"}</p><p className="mt-1 text-xs leading-5 text-slate-500">仍需以当前审核结论和快照有效性为准。</p></div>
            <div className="rounded-2xl border border-slate-200 px-4 py-3"><p className="text-xs font-semibold text-slate-500">风险</p><p className="mt-2 text-sm font-semibold text-slate-900">{selectedCandidate.riskLevel ? riskLabels[selectedCandidate.riskLevel] : "尚无审核结论"}</p><p className="mt-1 text-xs leading-5 text-slate-500">{selectedCandidate.conclusion && selectedCandidate.conclusion in conclusionLabels ? conclusionLabels[selectedCandidate.conclusion as ReviewConclusion] : "等待管理员记录受控结论"}</p></div>
          </div>
          {selectedCandidate.tool.description ? <div className="mt-5 rounded-2xl bg-slate-50 px-4 py-4"><p className="text-xs font-semibold text-slate-500">远端描述（不可信）</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{selectedCandidate.tool.description}</p></div> : null}
          <div className="mt-5 space-y-3">
            <SchemaBlock label="输入 Schema（已净化）" value={selectedCandidate.tool.inputSchema} />
            <SchemaBlock label="输出 Schema（已净化）" value={selectedCandidate.tool.outputSchema} />
            <SchemaBlock label="annotations（已净化）" value={selectedCandidate.tool.annotations} />
          </div>
          {effectiveReason(selectedCandidate) ? <p className="mt-5 rounded-2xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">当前安全状态：{effectiveReason(selectedCandidate)}。如需更新证据，请先确认旧证据的处理状态。</p> : null}
          {selectedCandidate.reviewStatus === "approved"
            ? <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-xs leading-5 text-emerald-800" role="status">当前 tuple 已有不可变 APPROVED 审核；为避免打断现有项目授权，不能重复提交正向审核。若快照失效，请先按治理流程处理旧证据。</div>
            : <ReviewForm key={selectedCandidate.tool.id} candidate={selectedCandidate} onCompleted={reviewCompleted} />}
        </> : <div className="flex min-h-80 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 text-center"><div><p className="text-sm font-semibold text-slate-700">选择一条候选查看审核详情</p><p className="mt-2 text-xs leading-5 text-slate-500">详情只包含净化后的 Schema、annotations、指纹和版本信息。</p></div></div>}
      </section>
    </div>
  </div>;
}
