"use client";

import { useEffect, useState } from "react";

type AiMemoryStatus = {
  configured: boolean;
  currentRevision: number | null;
  sourceIds: string[];
  operations: Array<{
    operation:
      | "autoExtract"
      | "embedding"
      | "sourceSummary"
      | "projectAnalysis"
      | "generateWithContext";
    modelId: string;
    grantId: string;
    sourceCount: number;
    expiresAt: string;
  }>;
  availableSourceCount: number;
  pendingCandidateCount: number;
  runtime: {
    configured: boolean;
    errorCode: "AI_DISABLED" | "AI_PROVIDER_DISABLED" | null;
    responseModelId: string;
    embeddingModelId: string;
  };
  externalTransferExecution: {
    enabled: false;
    reasonCode: "EXTERNAL_TRANSFER_NOT_ENABLED";
  };
};

type AiCandidate = {
  id: string;
  sourceId: string;
  itemType: "decision" | "progress" | "issue" | "risk";
  statement: string;
  sourceExcerpt: string;
  sourceStart: number;
  sourceEnd: number;
  reviewStatus: "candidate" | "accepted" | "dismissed";
  createdAt: string;
  projectItem: {
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
    title: string;
    content: string;
    sourceExcerpt: string | null;
    occurredAt: string | null;
    updatedAt: string;
  };
};

type CandidateDraft = {
  type: AiCandidate["itemType"];
  title: string;
  content: string;
  occurredAt: string;
  expectedItemUpdatedAt: string;
};

type ErrorPayload = { error?: { message?: string } };

const candidateTypes: Array<{ value: AiCandidate["itemType"]; label: string }> = [
  { value: "decision", label: "Decision · 决策" },
  { value: "progress", label: "Progress · 进展" },
  { value: "issue", label: "Issue · 问题" },
  { value: "risk", label: "Risk · 风险" },
];

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorPayload;
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadStatus(projectId: string): Promise<AiMemoryStatus> {
  const response = await fetch(`/api/projects/${projectId}/ai-memory`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as {
    aiMemory?: AiMemoryStatus;
    error?: { message?: string };
  };
  if (!response.ok || payload.aiMemory === undefined) {
    throw new Error(payload.error?.message ?? "AI 记忆状态加载失败");
  }
  return payload.aiMemory;
}

async function loadPendingCandidates(projectId: string): Promise<AiCandidate[]> {
  const response = await fetch(
    `/api/projects/${projectId}/ai-memory/candidates?reviewStatus=candidate&take=100`,
    { cache: "no-store" },
  );
  const payload = (await response.json()) as {
    candidates?: AiCandidate[];
    error?: { message?: string };
  };
  if (!response.ok || payload.candidates === undefined) {
    throw new Error(payload.error?.message ?? "AI 候选加载失败");
  }
  return payload.candidates;
}

function dateTimeLocal(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function candidateDrafts(candidates: readonly AiCandidate[]): Record<string, CandidateDraft> {
  return Object.fromEntries(candidates.map((candidate) => [
    candidate.id,
    {
      type: candidate.projectItem.type,
      title: candidate.projectItem.title,
      content: candidate.projectItem.content,
      occurredAt: dateTimeLocal(candidate.projectItem.occurredAt),
      expectedItemUpdatedAt: candidate.projectItem.updatedAt,
    },
  ]));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AiMemoryPanel({
  projectId,
  sourceSetKey,
  onReviewComplete,
}: {
  projectId: string;
  sourceSetKey: string;
  onReviewComplete: () => Promise<void>;
}) {
  const [status, setStatus] = useState<AiMemoryStatus | null>(null);
  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [nextStatus, nextCandidates] = await Promise.all([
      loadStatus(projectId),
      loadPendingCandidates(projectId),
    ]);
    setStatus(nextStatus);
    setCandidates(nextCandidates);
    setDrafts(candidateDrafts(nextCandidates));
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadStatus(projectId), loadPendingCandidates(projectId)])
      .then(([nextStatus, nextCandidates]) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setCandidates(nextCandidates);
        setDrafts(candidateDrafts(nextCandidates));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "AI 记忆工作台加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadedProjectId(projectId);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sourceSetKey]);

  const isLoading = loadedProjectId !== projectId;

  function updateDraft(candidateId: string, update: Partial<CandidateDraft>): void {
    setDrafts((current) => ({
      ...current,
      [candidateId]: { ...current[candidateId]!, ...update },
    }));
  }

  async function reviewCandidate(
    candidate: AiCandidate,
    action: "accept" | "dismiss",
  ): Promise<void> {
    if (reviewingId !== null) return;
    const draft = drafts[candidate.id];
    if (draft === undefined) return;

    let occurredAt: string | null = null;
    if (action === "accept" && draft.occurredAt) {
      const date = new Date(draft.occurredAt);
      if (!Number.isFinite(date.getTime())) {
        setError("候选发生时间格式无效");
        return;
      }
      occurredAt = date.toISOString();
    }

    setReviewingId(candidate.id);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/ai-memory/candidates/${candidate.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action === "accept"
            ? {
                action,
                expectedItemUpdatedAt: draft.expectedItemUpdatedAt,
                type: draft.type,
                title: draft.title,
                content: draft.content,
                occurredAt,
              }
            : {
                action,
                expectedItemUpdatedAt: draft.expectedItemUpdatedAt,
              }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, "AI 候选审阅失败"));
      }
      await refresh();
      await onReviewComplete();
      setSuccess(action === "accept" ? "AI 候选已由人工确认。" : "AI 候选已驳回。");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "AI 候选审阅失败");
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <section aria-labelledby="ai-memory-heading" className="mt-10 rounded-3xl border border-indigo-200 bg-indigo-50/40 p-7 shadow-sm sm:p-8">
      <div className="flex flex-col gap-4 border-b border-indigo-100 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Governed AI memory</p>
          <h2 id="ai-memory-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">AI 记忆工作台</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">模型产物先作为带原文证据的候选进入这里。接受前可以修订类型、标题和内容；来源与精确摘录不可更换，且任何候选都不会自动确认为项目事实。</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className={`rounded-full border px-3 py-1.5 ${status?.configured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-600"}`}>
            {status?.configured ? "授权已配置" : "授权未配置"}
          </span>
          <span className={`rounded-full border px-3 py-1.5 ${status?.runtime.configured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
            {status?.runtime.configured ? "运行时已配置" : "运行时未启用"}
          </span>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600">外部传输未开放</span>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="note">
        当前网页只有状态读取和人工候选审阅，不提供模型传输授权写入，也没有真实外部调用入口。授权创建或撤销必须在本机执行受控 CLI。
      </div>

      {error ? <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">{error}</div> : null}
      {success ? <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status">{success}</div> : null}

      {status ? (
        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-indigo-100 bg-white p-4"><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">可用 Source</dt><dd className="mt-2 text-xl font-semibold text-slate-950">{status.availableSourceCount}</dd></div>
          <div className="rounded-2xl border border-indigo-100 bg-white p-4"><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">授权 Source</dt><dd className="mt-2 text-xl font-semibold text-slate-950">{status.sourceIds.length}</dd></div>
          <div className="rounded-2xl border border-indigo-100 bg-white p-4"><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">待审阅候选</dt><dd className="mt-2 text-xl font-semibold text-slate-950">{status.pendingCandidateCount}</dd></div>
          <div className="rounded-2xl border border-indigo-100 bg-white p-4"><dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">策略修订</dt><dd className="mt-2 text-xl font-semibold text-slate-950">{status.currentRevision ?? "—"}</dd></div>
        </dl>
      ) : null}

      {status?.operations.length ? (
        <div className="mt-5 flex flex-wrap gap-2 text-xs text-slate-600">
          {status.operations.map((operation) => (
            <span key={operation.operation} className="rounded-full border border-indigo-100 bg-white px-3 py-1.5">
              {operation.operation} · {operation.modelId} · {operation.sourceCount} sources · 至 {formatDate(operation.expiresAt)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-8 border-t border-indigo-100 pt-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Human review queue</p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">待审阅模型候选</h3>
          </div>
          <span className="text-xs text-slate-500">{isLoading ? "读取中…" : `${candidates.length} 条`}</span>
        </div>

        {isLoading ? (
          <div className="mt-5 h-48 animate-pulse rounded-2xl bg-white" aria-label="正在加载 AI 候选" />
        ) : candidates.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-indigo-200 bg-white/70 px-6 py-10 text-center">
            <p className="text-sm font-medium text-slate-700">当前没有待审阅的模型候选</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">尚未执行模型抽取，或已有候选已全部完成人工审阅。</p>
          </div>
        ) : (
          <ul className="mt-5 space-y-5" aria-label="AI 候选审阅列表">
            {candidates.map((candidate) => {
              const draft = drafts[candidate.id];
              if (draft === undefined) return null;
              const pending = reviewingId === candidate.id;
              const disabled = reviewingId !== null;
              return (
                <li key={candidate.id} className="rounded-2xl border border-indigo-100 bg-white p-5 sm:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-indigo-100 px-2.5 py-1 font-semibold text-indigo-700">AI 候选</span>
                      <span className="text-slate-500">生成于 {formatDate(candidate.createdAt)}</span>
                    </div>
                    <code className="text-[11px] text-slate-400">{candidate.id}</code>
                  </div>

                  <div className="mt-5 grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400" htmlFor={`candidate-type-${candidate.id}`}>人工确认类型</label>
                      <select id={`candidate-type-${candidate.id}`} value={draft.type} onChange={(event) => updateDraft(candidate.id, { type: event.target.value as CandidateDraft["type"] })} disabled={disabled} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60">
                        {candidateTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                      </select>

                      <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400" htmlFor={`candidate-title-${candidate.id}`}>人工确认标题</label>
                      <input id={`candidate-title-${candidate.id}`} value={draft.title} onChange={(event) => updateDraft(candidate.id, { title: event.target.value })} maxLength={160} disabled={disabled} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60" />

                      <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400" htmlFor={`candidate-content-${candidate.id}`}>人工确认内容</label>
                      <textarea id={`candidate-content-${candidate.id}`} value={draft.content} onChange={(event) => updateDraft(candidate.id, { content: event.target.value })} maxLength={20000} rows={5} disabled={disabled} className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60" />

                      <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400" htmlFor={`candidate-occurred-${candidate.id}`}>发生时间（可选）</label>
                      <input id={`candidate-occurred-${candidate.id}`} type="datetime-local" value={draft.occurredAt} onChange={(event) => updateDraft(candidate.id, { occurredAt: event.target.value })} disabled={disabled} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60" />
                    </div>

                    <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-indigo-600">模型原始陈述</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{candidate.statement}</p>
                      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-indigo-600">不可更换的精确原文证据</p>
                      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-indigo-300 pl-3 text-sm leading-6 text-slate-700">{candidate.sourceExcerpt}</blockquote>
                      <dl className="mt-5 grid gap-3 border-t border-indigo-100 pt-4 text-xs text-slate-500 sm:grid-cols-2">
                        <div><dt className="font-semibold text-slate-400">Source ID</dt><dd className="mt-1 break-all font-mono">{candidate.sourceId}</dd></div>
                        <div><dt className="font-semibold text-slate-400">UTF-8 范围</dt><dd className="mt-1 font-mono">{candidate.sourceStart}–{candidate.sourceEnd}</dd></div>
                      </dl>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
                    <button type="button" onClick={() => void reviewCandidate(candidate, "dismiss")} disabled={disabled} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "处理中…" : "驳回候选"}</button>
                    <button type="button" onClick={() => void reviewCandidate(candidate, "accept")} disabled={disabled || !draft.title.trim() || !draft.content.trim()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "处理中…" : "确认并写入记忆"}</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
