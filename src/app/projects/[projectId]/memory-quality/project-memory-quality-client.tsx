"use client";

import { DialogActions } from "@/components/dialog-actions";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import ui from "@/components/workspace-ui.module.css";
import { OperationPanel } from "@/components/operation-panel";
import { ProjectIntelligenceParentLink } from "@/components/project-parent-link";

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
  duplicate: { label: "可能重复", tone: "bg-app-accent-soft text-app-link", description: "合并条目并保留双方证据。" },
  conflict: { label: "内容冲突", tone: "bg-app-danger-soft text-app-danger-ink", description: "判定有效版本，必要时建立替代关系。" },
  stale: { label: "需要复核", tone: "bg-app-warning-soft text-app-warning-ink", description: "确认仍有效、设置有效期或归档。" },
  missingEvidence: { label: "证据不足", tone: "bg-orange-50 text-orange-700", description: "补充可定位的来源证据后再确认。" },
  lowConfidence: { label: "低置信度", tone: "bg-app-accent-soft text-app-link", description: "人工核对内容并更新置信度。" },
};

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function ProjectMemoryQualityClient({ username, projectId, isSystemAdmin, embedded = false }: { username: string; projectId: string; isSystemAdmin: boolean; embedded?: boolean }) {
  const translateUi = useTranslate();
  const [quality, setQuality] = useState<QualitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory-quality`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "记忆质量加载失败"));
      setQuality((await response.json() as { quality: QualitySummary }).quality);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记忆质量加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload({ showLoading: true }), 0); return () => window.clearTimeout(timer); }, [reload]);

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

  const RootElement = embedded ? "section" : "main";
  return (
    <RootElement className={embedded ? "text-app-text" : "min-h-screen bg-[var(--app-bg)] text-app-text"}>
      {!embedded ? <AppHeader username={username} active="projects" projectId={projectId} projectSection="memoryQuality" isSystemAdmin={isSystemAdmin} /> : null}
      <div data-page-content={!embedded ? "" : undefined} className={embedded ? "" : ui.page}>
        {!embedded ? <>        <div className="mb-5"><ProjectIntelligenceParentLink projectId={projectId} /></div>
        <section className={ui.heading}>
          <div><h1><UiText text="记忆质量与生命周期" /></h1><p><UiText text="用确定性规则识别重复、冲突、过期、证据不足和低置信度记忆。检查本身不会调用模型，也不会把项目内容发送到外部服务。" /></p></div>
          <button onClick={() => void analyze()} disabled={analyzing} className={ui.button}>{analyzing ? <UiText text="检查中…" /> : <UiText text="立即检查" />}</button>
        </section></> : <div className="flex items-center justify-between"><span className="text-xs text-app-muted"><UiText text={"按当前来源核对重复、冲突与有效期"} /></span><button type="button" onClick={() => void analyze()} disabled={analyzing} className="rounded-control border border-app-border px-3 py-2 text-xs">{analyzing ? <UiText text={"检查中…"} /> : <UiText text={"重新检查"} />}</button></div>}

        {error ? <div role="alert" className="mt-6 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /></div> : null}
        <section className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <ScoreCard score={quality?.score ?? 100} loading={loading} />
          {(Object.keys(kindMeta) as QualityKind[]).map((kind) => <MetricCard key={kind} label={kindMeta[kind].label} value={quality?.counts[kind] ?? 0} />)}
        </section>

        <section className="mt-9">
          <div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-app-muted"><UiText text={"Review queue"} /></p><h2 className="mt-2 text-base font-semibold"><UiText text={"待处理问题"} /></h2></div><span className="text-xs text-app-muted">{loading ? <UiText text={"读取中…"} /> : translateUi("{count} 项").replace("{count}", String(quality?.openIssueCount ?? 0))}</span></div>
          <div className="space-y-4">
            {!loading && (quality?.issues.filter((issue) => issue.status === "open").length ?? 0) === 0 ? <div className="rounded-panel border border-dashed border-app-border bg-app-surface px-6 py-16 text-center"><p className="text-base font-semibold text-app-text"><UiText text={"当前没有待处理质量问题"} /></p><p className="mt-2 text-sm text-app-muted"><UiText text={"新资料进入或条目更新后，可再次运行检查。"} /></p></div> : null}
            {quality?.issues.filter((issue) => issue.status === "open").map((issue) => <IssueCard key={issue.id} projectId={projectId} issue={issue} onChanged={reload} />)}
          </div>
        </section>
      </div>
    </RootElement>
  );
}

function ScoreCard({ score, loading }: { score: number; loading: boolean }) {
  const tone = score >= 85 ? "text-app-success-ink" : score >= 65 ? "text-app-warning-ink" : "text-app-danger-ink";
  return <article className="rounded-panel border border-app-border bg-app-surface p-5 sm:col-span-2 lg:col-span-1 app-panel"><p className="text-xs font-semibold text-app-muted"><UiText text={"质量分"} /></p><strong className={`mt-3 block text-4xl ${tone}`}>{loading ? "—" : score}</strong><p className="mt-2 text-[12px] text-app-muted"><UiText text={"确定性治理评分"} /></p></article>;
}

function MetricCard({ label, value }: { label: string; value: number }) {
  const translateUi = useTranslate();
  return <article className="rounded-panel border border-app-border bg-app-surface p-5 app-panel"><p className="text-xs font-semibold text-app-muted">{translateUi(label)}</p><strong className="mt-3 block text-3xl text-app-text">{value}</strong><p className="mt-2 text-[12px] text-app-muted"><UiText text={"待人工处置"} /></p></article>;
}

function IssueCard({ projectId, issue, onChanged }: { projectId: string; issue: QualityIssue; onChanged: () => Promise<void> }) {
  const translateUi = useTranslate();
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
  return <article className="rounded-panel border border-app-border bg-app-surface p-6 app-panel"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${meta.tone}`}>{translateUi(meta.label)}</span><span className="text-[12px] text-app-muted"><UiText text={"置信强度"} />{" "}{Math.round(issue.score * 100)}%</span></div><h3 className="mt-3 text-lg font-semibold">{issue.primaryItem.title}</h3><p className="mt-2 text-sm leading-6 text-app-muted">{issue.explanation}</p>{issue.relatedItem ? <div className="mt-4 rounded-panel bg-app-surface-soft px-4 py-3"><span className="text-[12px] font-semibold text-app-muted"><UiText text={"关联条目"} /></span><p className="mt-1 text-sm font-medium text-app-text">{issue.relatedItem.title}</p></div> : null}</div><div className="flex gap-2"><button onClick={() => void resolve("dismissed")} disabled={pending} className="rounded-control px-3 py-2 text-xs font-semibold text-app-muted hover:bg-app-surface-soft disabled:opacity-50"><UiText text={"不适用"} /></button><button onClick={() => void resolve("resolved")} disabled={pending} className="rounded-control px-4 py-2 text-xs font-semibold disabled:opacity-50 app-button-primary"><UiText text={"标记已处理"} /></button></div></div><p className="mt-4 text-xs text-app-muted"><UiText text={"建议："} />{translateUi(meta.description)}</p>{message ? <p role="alert" className="mt-3 text-xs text-app-danger-ink app-feedback-error"><UiFeedbackText text={message} /></p> : null}<ItemMetadataEditor projectId={projectId} item={issue.primaryItem} onChanged={onChanged} /></article>;
}

function ItemMetadataEditor({ projectId, item, onChanged }: { projectId: string; item: MemoryItem; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [importance, setImportance] = useState(String(item.importance));
  const [confidence, setConfidence] = useState(item.confidence === null ? "" : String(item.confidence));
  const [validUntil, setValidUntil] = useState(item.validUntil?.slice(0, 10) ?? "");
  const [pinned, setPinned] = useState(item.pinned);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function save(verifyNow = false): Promise<boolean> {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/items/${item.id}/memory-metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: item.updatedAt, importance: Number(importance), confidence: confidence.trim() === "" ? null : Number(confidence), validUntil: validUntil === "" ? null : new Date(`${validUntil}T23:59:59.000Z`).toISOString(), pinned, verifyNow }) });
      if (!response.ok) throw new Error(await responseError(response, "生命周期设置保存失败"));
      setMessage(verifyNow ? "已记录本次人工复核。" : "生命周期设置已保存。");
      await onChanged();
      return true;
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "生命周期设置保存失败"); return false; }
    finally { setPending(false); }
  }
  return <div className="mt-5 border-t border-app-border pt-4"><OperationPanel title={`编辑“${item.title}”的生命周期`} triggerLabel="编辑生命周期" open={open} onOpenChange={setOpen} disabled={pending} description="调整记忆质量元数据；保存并记录已复核会额外写入本次人工复核状态。">
    <div>
      <div className="grid gap-3 md:grid-cols-4"><label className="text-xs font-medium text-app-muted"><UiText text={"置信度 0–1"} /><input type="number" min="0" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(event.target.value)} className="mt-1 w-full rounded-field border border-app-border bg-app-surface px-3 py-2 text-sm app-field" /></label><label className="text-xs font-medium text-app-muted"><UiText text={"重要性 0–100"} /><input type="number" min="0" max="100" value={importance} onChange={(event) => setImportance(event.target.value)} className="mt-1 w-full rounded-field border border-app-border bg-app-surface px-3 py-2 text-sm app-field" /></label><label className="text-xs font-medium text-app-muted"><UiText text={"有效截止"} /><input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="mt-1 w-full rounded-field border border-app-border bg-app-surface px-3 py-2 text-sm app-field" /></label><label className="flex items-center gap-2 pt-5 text-xs font-medium text-app-muted"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><UiText text={"长期置顶，不按时间过期"} /></label></div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2"><DialogActions><button type="button" onClick={async () => { if (await save(false)) setOpen(false); }} disabled={pending} className="app-button-secondary app-button-compact rounded-control border font-semibold disabled:opacity-50"><UiText text={"保存设置"} /></button><button type="button" onClick={async () => { if (await save(true)) setOpen(false); }} disabled={pending} className="app-button-primary app-button-compact rounded-control font-semibold disabled:opacity-50"><UiText text={"保存并记录已复核"} /></button></DialogActions>{message ? <span role="status" className="self-center text-xs text-app-muted app-feedback-info"><UiFeedbackText text={message} /></span> : null}</div>
    </div>
  </OperationPanel></div>;
}
