"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { projectJobUnknownPresentation } from "@/lib/project-job-outcome-presentation";
import styles from "./project-materials.module.css";
import { formatUiDateTimeOrFallback } from "@/lib/ui-date-format";

type ProcessingJob = Readonly<{
  id: string;
  kind: "assetExtract" | "autoExtract";
  status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  stage: string;
  result: unknown;
  progressCurrent: number;
  progressTotal: number;
  failureCode: string | null;
  reconciliationRequired: boolean;
  canCancel: boolean;
  inputSummary:
    | { displayName: string | null; fileName: string | null }
    | { sourceCount: number; sourceLabels: string[] }
    | null;
  createdAt: string;
  completedAt: string | null;
}>;

const activeStatuses = new Set<ProcessingJob["status"]>(["queued", "waitingConsent", "running"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function statusLabel(status: ProcessingJob["status"]): string {
  return {
    queued: "排队中",
    waitingConsent: "等待确认",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
    unknown: "结果未知",
    cancelled: "已取消",
  }[status];
}

function stageLabel(stage: string): string {
  return {
    worker_queued: "等待后台开始",
    worker_processing: "正在读取资料",
    extracting: "正在整理资料",
    recognizing: "正在识别文件内容",
    cancelled: "已取消",
    succeeded: "处理完成",
    failed: "处理失败",
    unknown: "结果未知",
  }[stage] ?? "后台处理中";
}

function resultSummary(job: ProcessingJob, t: (text: string) => string): string | null {
  const result = record(job.result);
  if (job.kind === "autoExtract") {
    const confirmed = count(result.confirmedCount);
    const review = count(result.reviewRequiredCount);
    const duplicates = count(result.duplicateCount);
    if (confirmed === null || review === null || duplicates === null) return null;
    return t("已形成 {confirmed} 条事实 · {review} 条待核对 · {duplicates} 条重复").replace("{confirmed}", String(confirmed)).replace("{review}", String(review)).replace("{duplicates}", String(duplicates));
  }
  const segments = count(result.visionSegmentCount);
  return segments === null ? null : t("识别完成，共 {count} 个片段等待人工核对").replace("{count}", String(segments));
}

function inputSummaryLabel(job: ProcessingJob, t: (text: string) => string): string | null {
  if (job.inputSummary === null) return null;
  if (job.kind === "assetExtract" && "displayName" in job.inputSummary) {
    return [job.inputSummary.displayName, job.inputSummary.fileName].filter((label): label is string => label !== null).join(" · ") || null;
  }
  if (job.kind === "autoExtract" && "sourceCount" in job.inputSummary) {
    const labels = job.inputSummary.sourceLabels.join("、");
    return labels.length > 0
      ? `${labels}${job.inputSummary.sourceCount > job.inputSummary.sourceLabels.length ? ` ${t("等 {count} 份资料").replace("{count}", String(job.inputSummary.sourceCount))}` : ""}`
      : t("共 {count} 份资料").replace("{count}", String(job.inputSummary.sourceCount));
  }
  return null;
}

function formatCreatedAt(value: string, language: "zh-CN" | "en", t: (text: string) => string): string {
  const date = new Date(value);
  return formatUiDateTimeOrFallback(date, language, t("时间未知"), {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function ProjectProcessingTasks({ projectId, onChanged }: {
  projectId: string;
  onChanged?: () => Promise<void>;
}) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [polling, setPolling] = useState(false);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store", signal });
    const payload = await response.json() as { jobs?: ProcessingJob[]; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? "任务列表读取失败");
    const processingJobs = (payload.jobs ?? []).filter((job) => job.kind === "assetExtract" || job.kind === "autoExtract");
    setJobs(processingJobs);
    return processingJobs;
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let attempts = 0;
    let active = true;
    const poll = async () => {
      try {
        const current = await reload(controller.signal);
        if (!active) return;
        setError(null);
        setLoading(false);
        attempts += 1;
        if (current.some((job) => activeStatuses.has(job.status)) && attempts < 120) {
          setPolling(true);
          timer = window.setTimeout(() => void poll(), 5_000);
        } else {
          setPolling(false);
        }
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "任务列表读取失败");
        setLoading(false);
        setPolling(false);
      }
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectId, refreshToken, reload]);

  async function cancel(job: ProcessingJob) {
    setCanceling(job.id);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/jobs/${job.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const payload = await response.json() as { error?: { message?: string; code?: string } };
      if (!response.ok) {
        throw new Error(response.status === 409
          ? "任务已进入不可安全取消的阶段；系统会继续保留真实结果，不会假装已取消。"
          : payload.error?.message ?? "取消任务失败");
      }
      setNotice("任务已取消，尚未发送的请求不会继续执行。");
      await reload();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消任务失败");
    } finally {
      setCanceling(null);
    }
  }

  const pendingCount = jobs.filter((job) => activeStatuses.has(job.status)).length;
  return <section aria-labelledby="project-processing-tasks-title" className={styles.tasksSection}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="project-processing-tasks-title" className="text-lg font-semibold text-slate-950"><UiText text={"识别任务"} /></h2>
        <p className="mt-1 text-xs leading-5 text-slate-600"><UiText text={"查看后台进度与保存结果。仅允许取消尚未发送的任务；异常任务会区分抽取结果与调用记录。"} /></p>
      </div>
      <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="min-h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700"><UiText text={"刷新"} /></button>
    </div>
    {pendingCount > 0 ? <p role="status" className="mt-3 text-xs text-indigo-700">{pendingCount} {" "}<UiText text={"项处理中"} />{polling ? <UiText text={"，每 5 秒更新一次"} /> : <UiText text={"，自动刷新已暂停，可手动刷新"} />}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm text-emerald-700"><UiFeedbackText text={notice} /></p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
    {loading ? <p className="mt-4 text-sm text-slate-500"><UiText text={"正在读取任务…"} /></p> : error ? null : jobs.length === 0 ? <p className="mt-4 rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-500"><UiText text={"目前没有识别或整理任务。可以回到资料栏目添加内容或确认 AI 整理。"} /></p> : <div className="mt-4 space-y-2">{jobs.map((job) => {
      const progress = job.progressTotal > 0 ? Math.min(100, Math.round(job.progressCurrent / job.progressTotal * 100)) : null;
      const canCancel = job.canCancel && canceling !== job.id;
      const inputLabel = inputSummaryLabel(job, translateUi);
      const unknownOutcome = projectJobUnknownPresentation(job);
      return <article key={job.id} className={styles.taskCard}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold text-slate-900">{job.kind === "assetExtract" ? <UiText text={"文件图片识别"} /> : <UiText text={"资料自动整理"} />}</h3>{inputLabel ? <p className="mt-1 max-w-2xl break-all text-xs text-slate-600">{inputLabel}</p> : null}<p className="mt-1 text-xs text-slate-500">{translateUi(unknownOutcome?.label ?? statusLabel(job.status))} · {translateUi(unknownOutcome?.stageLabel ?? stageLabel(job.stage))} {" "}<UiText text={"· 创建于"} />{" "}{formatCreatedAt(job.createdAt, language, translateUi)}</p></div>
          {canCancel ? <button type="button" onClick={() => void cancel(job)} className="min-h-9 rounded-lg border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700"><UiText text={"取消任务"} /></button> : canceling === job.id ? <span className="text-xs text-slate-500"><UiText text={"正在取消…"} /></span> : null}
        </div>
        {progress !== null ? <div className="mt-3"><div className="flex justify-between text-xs text-slate-500"><span><UiText text={"处理进度"} /></span><span>{job.progressCurrent}/{job.progressTotal}{language === "en" ? ` (${progress}%)` : `（${progress}%）`}</span></div><div className={`${styles.taskProgress} mt-1`} role="progressbar" aria-valuemin={0} aria-valuemax={job.progressTotal} aria-valuenow={job.progressCurrent} aria-label={translateUi("{kind}进度").replace("{kind}", translateUi(job.kind === "assetExtract" ? "文件图片识别" : "资料自动整理"))}><div className={styles.taskProgressFill} style={{ width: `${progress}%` }} /></div></div> : null}
        {job.status === "succeeded" ? <p className="mt-3 text-sm text-emerald-800">{resultSummary(job, translateUi) ?? <UiText text={"任务已完成，结果已保存。"} />}</p> : null}
        {job.status === "failed" ? <p className="mt-3 text-sm text-rose-700"><UiText text={"任务失败"} />{job.failureCode ? language === "en" ? ` (${job.failureCode})` : `（${job.failureCode}）` : ""}<UiText text={"。原始资料仍保留。"} /></p> : null}
        {unknownOutcome ? <div className={`mt-3 text-sm leading-6 ${unknownOutcome.tone === "danger" ? "text-rose-700" : "text-amber-800"}`}><p>{translateUi(unknownOutcome.summary)}{job.failureCode ? language === "en" ? ` (${job.failureCode})` : `（${job.failureCode}）` : ""}</p><p>{translateUi(unknownOutcome.recordNotice)}</p></div> : job.reconciliationRequired ? <p className="mt-3 text-sm text-amber-800"><UiText text={"外部调用记录仍需核对，请查看任务详情；系统不会自动重试。"} /></p> : null}
        {job.status === "cancelled" ? <p className="mt-3 text-sm text-slate-600"><UiText text={"任务已取消，原始资料仍保留。"} /></p> : null}
        <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold text-indigo-700"><Link href={`/projects/${projectId}/jobs/${job.id}`} className="underline"><UiText text={"查看任务详情"} /></Link>{job.kind === "assetExtract" && job.status === "succeeded" ? <Link href={`/projects/${projectId}/assets`} className="underline"><UiText text={"核对识别结果"} /></Link> : null}{job.kind === "autoExtract" && job.status === "succeeded" ? <Link href={`/projects/${projectId}/materials?view=review&from=materials`} className="underline"><UiText text={"查看整理结果"} /></Link> : null}</div>
      </article>;
    })}</div>}
  </section>;
}
