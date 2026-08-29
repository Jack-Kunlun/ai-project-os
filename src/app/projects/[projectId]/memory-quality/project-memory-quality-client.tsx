"use client";

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";

type QualityKind = "duplicate" | "conflict" | "stale" | "missingEvidence" | "lowConfidence";
type MemoryItem = {
  id: string;
  type: string;
  title: string;
  content: string;
  reviewStatus: string;
  confidence: number | null;
  importance: number;
  validUntil: string | null;
  pinned: boolean;
  lastVerifiedAt: string | null;
  updatedAt: string;
};
type QualityIssue = {
  id: string;
  kind: QualityKind;
  status: "open" | "resolved" | "dismissed";
  score: number;
  explanation: string;
  detectedAt: string;
  resolutionNote: string | null;
  primaryItem: MemoryItem;
  relatedItem: MemoryItem | null;
};
type QualitySummary = {
  score: number;
  openIssueCount: number;
  counts: Record<QualityKind, number>;
  issues: QualityIssue[];
};

const kindMeta: Record<QualityKind, { label: string; tone: string; description: string }> = {
  duplicate: { label: "可能重复", tone: "bg-violet-50 text-violet-700", description: "合并条目并保留双方证据。" },
  conflict: { label: "内容冲突", tone: "bg-rose-50 text-rose-700", description: "判定有效版本，必要时建立替代关系。" },
  stale: { label: "需要复核", tone: "bg-amber-50 text-amber-700", description: "确认仍有效、设置有效期或归档。" },
  missingEvidence: { label: "证据不足", tone: "bg-orange-50 text-orange-700", description: "补充可定位的来源证据后再确认。" },
  lowConfidence: { label: "低置信度", tone: "bg-sky-50 text-sky-700", description: "人工核对内容并更新置信度。" },
};

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function ProjectMemoryQualityClient({ username, projectId }: { username: string; projectId: string }) {
  const [quality, setQuality] = useState<QualitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory-quality`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "记忆质量加载失败"));
      setQuality((await response.json() as { quality: QualitySummary }).quality);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记忆质量加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  async function analyze() {
    setAnalyzing(true); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory-quality`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "记忆质量检查失败"));
      setQuality((await response.json() as { quality: QualitySummary }).quality);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记忆质量检查失败");
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="memoryQuality" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <section className="overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Memory governance</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">记忆质量与生命周期</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">用确定性规则识别重复、冲突、过期、证据不足和低置信度记忆。检查本身不会调用模型，也不会把项目内容发送到外部服务。</p></div>
            <button onClick={() => void analyze()} disabled={analyzing} className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 shadow-sm hover:bg-indigo-50 disabled:opacity-50">{analyzing ? "检查中…" : "立即检查"}</button>
          </div>
        </section>

        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <section className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <ScoreCard score={quality?.score ?? 100} loading={loading} />
          {(Object.keys(kindMeta) as QualityKind[]).map((kind) => <MetricCard key={kind} label={kindMeta[kind].label} value={quality?.counts[kind] ?? 0} />)}
        </section>

        <section className="mt-9">
          <div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Review queue</p><h2 className="mt-2 text-2xl font-semibold">待处理问题</h2></div><span className="text-xs text-slate-400">{loading ? "读取中…" : `${quality?.openIssueCount ?? 0} 项`}</span></div>
          <div className="space-y-4">
            {!loading && (quality?.issues.filter((issue) => issue.status === "open").length ?? 0) === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center"><p className="text-base font-semibold text-slate-700">当前没有待处理质量问题</p><p className="mt-2 text-sm text-slate-500">新资料进入或条目更新后，可再次运行检查。</p></div> : null}
            {quality?.issues.filter((issue) => issue.status === "open").map((issue) => <IssueCard key={issue.id} projectId={projectId} issue={issue} onChanged={reload} />)}
          </div>
        </section>
      </div>
    </main>
  );
}

function ScoreCard({ score, loading }: { score: number; loading: boolean }) {
  const tone = score >= 85 ? "text-emerald-600" : score >= 65 ? "text-amber-600" : "text-rose-600";
  return <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:col-span-2 lg:col-span-1"><p className="text-xs font-semibold text-slate-400">质量分</p><strong className={`mt-3 block text-4xl ${tone}`}>{loading ? "—" : score}</strong><p className="mt-2 text-[11px] text-slate-400">确定性治理评分</p></article>;
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><strong className="mt-3 block text-3xl text-slate-900">{value}</strong><p className="mt-2 text-[11px] text-slate-400">待人工处置</p></article>;
}

function IssueCard({ projectId, issue, onChanged }: { projectId: string; issue: QualityIssue; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const meta = kindMeta[issue.kind];
  async function resolve(status: "resolved" | "dismissed") {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory-quality/issues/${issue.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, note: status === "resolved" ? "已人工核对并完成处置" : "已人工核对，本次检测不适用" }) });
      if (!response.ok) throw new Error(await responseError(response, "质量问题处理失败"));
      await onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "质量问题处理失败"); }
    finally { setPending(false); }
  }
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.tone}`}>{meta.label}</span><span className="text-[11px] text-slate-400">置信强度 {Math.round(issue.score * 100)}%</span></div><h3 className="mt-3 text-lg font-semibold">{issue.primaryItem.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{issue.explanation}</p>{issue.relatedItem ? <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3"><span className="text-[11px] font-semibold text-slate-400">关联条目</span><p className="mt-1 text-sm font-medium text-slate-700">{issue.relatedItem.title}</p></div> : null}</div><div className="flex gap-2"><button onClick={() => void resolve("dismissed")} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-50">不适用</button><button onClick={() => void resolve("resolved")} disabled={pending} className="rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">标记已处理</button></div></div><p className="mt-4 text-xs text-slate-400">建议：{meta.description}</p>{message ? <p role="alert" className="mt-3 text-xs text-rose-600">{message}</p> : null}<ItemMetadataEditor projectId={projectId} item={issue.primaryItem} onChanged={onChanged} /></article>;
}

function ItemMetadataEditor({ projectId, item, onChanged }: { projectId: string; item: MemoryItem; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [importance, setImportance] = useState(String(item.importance));
  const [confidence, setConfidence] = useState(item.confidence === null ? "" : String(item.confidence));
  const [validUntil, setValidUntil] = useState(item.validUntil?.slice(0, 10) ?? "");
  const [pinned, setPinned] = useState(item.pinned);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function save(verifyNow = false) {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/items/${item.id}/memory-metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: item.updatedAt, importance: Number(importance), confidence: confidence.trim() === "" ? null : Number(confidence), validUntil: validUntil === "" ? null : new Date(`${validUntil}T23:59:59.000Z`).toISOString(), pinned, verifyNow }) });
      if (!response.ok) throw new Error(await responseError(response, "生命周期设置保存失败"));
      setMessage(verifyNow ? "已记录本次人工复核。" : "生命周期设置已保存。");
      await onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "生命周期设置保存失败"); }
    finally { setPending(false); }
  }
  return <div className="mt-5 border-t border-slate-100 pt-4"><button onClick={() => setOpen((value) => !value)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">{open ? "收起生命周期设置" : "编辑置信度、重要性与有效期"}</button>{open ? <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4 md:grid-cols-4"><label className="text-xs font-medium text-slate-600">置信度 0–1<input type="number" min="0" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-slate-600">重要性 0–100<input type="number" min="0" max="100" value={importance} onChange={(event) => setImportance(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-slate-600">有效截止<input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" /></label><label className="flex items-center gap-2 pt-5 text-xs font-medium text-slate-600"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />长期置顶，不按时间过期</label><div className="flex flex-wrap gap-2 md:col-span-4"><button onClick={() => void save(false)} disabled={pending} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">保存设置</button><button onClick={() => void save(true)} disabled={pending} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">保存并记录已复核</button>{message ? <span role="status" className="self-center text-xs text-slate-500">{message}</span> : null}</div></div> : null}</div>;
}
