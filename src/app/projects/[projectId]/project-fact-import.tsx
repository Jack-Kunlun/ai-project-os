"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { modalPrimaryButtonClassName } from "@/components/modal-styles";
import Link from "next/link";
import { buildProjectHref } from "@/lib/project-navigation";
import { buildProjectQuestionHref } from "./materials/materials-navigation";
import { useEffect, useRef, useState } from "react";

type Confirmation = {
  challengeId: string;
  expiresAt: string;
  safeSummary: { route?: { provider?: { name?: string; kind?: string }; model?: string } };
};
type Batch = { sourceIds: string[]; clientKey: string; confirmation: Confirmation };
type ImportResult = { queued: number; completed: number; confirmed: number; review: number; duplicates: number; failed: number; unknown: number; cancelled: number; jobs: string[] };
type JobStatus = "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";

async function readPayload(response: Response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "AI 整理暂时不可用");
  return payload;
}

/** A single explicit consent covers the displayed, immutable import batches. */
export function ProjectFactImport({ projectId, sourceIds, onChanged }: {
  projectId: string;
  sourceIds: string[];
  onChanged: () => Promise<unknown>;
}) {
  const translateUi = useTranslate();
  const sourceKey = JSON.stringify([...new Set(sourceIds)].sort());
  const [batches, setBatches] = useState<Batch[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [retry, setRetry] = useState(0);
  const flight = useRef(false);
  const prepareVersion = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const jobsController = useRef<AbortController | null>(null);

  useEffect(() => () => jobsController.current?.abort(), []);

  async function monitorJobs(ids: string[]) {
    jobsController.current?.abort();
    const controller = new AbortController();
    jobsController.current = controller;
    try {
      for (let attempt = 0; attempt < 120 && !controller.signal.aborted; attempt += 1) {
        if (attempt > 0) await new Promise<void>((resolve, reject) => {
          const timeout = { id: 0 };
          const abort = () => {
            window.clearTimeout(timeout.id);
            reject(new DOMException("Aborted", "AbortError"));
          };
          timeout.id = window.setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 5_000);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        const response = await fetch(`/api/projects/${projectId}/jobs?ids=${encodeURIComponent(ids.join(","))}`, {
          cache: "no-store", signal: controller.signal,
        });
        const payload = await response.json() as { jobs?: Array<{ id: string; status: JobStatus; result?: { confirmedCount?: number; reviewRequiredCount?: number; duplicateCount?: number } | null }> ; error?: { message?: string } };
        if (!response.ok) throw new Error(payload.error?.message ?? "任务状态读取失败");
        const byId = new Map((payload.jobs ?? []).map((job) => [job.id, job]));
        const jobs = ids.flatMap((id) => {
          const job = byId.get(id);
          return job === undefined ? [] : [job];
        });
        const terminal = new Set<JobStatus>(["succeeded", "failed", "unknown", "cancelled"]);
        const succeeded = jobs.filter((job) => job.status === "succeeded");
        const next: ImportResult = {
          jobs: [...ids],
          queued: ids.length - jobs.filter((job) => terminal.has(job.status)).length,
          completed: succeeded.length,
          confirmed: succeeded.reduce((sum, job) => sum + (job.result?.confirmedCount ?? 0), 0),
          review: succeeded.reduce((sum, job) => sum + (job.result?.reviewRequiredCount ?? 0), 0),
          duplicates: succeeded.reduce((sum, job) => sum + (job.result?.duplicateCount ?? 0), 0),
          failed: jobs.filter((job) => job.status === "failed").length,
          unknown: jobs.filter((job) => job.status === "unknown").length,
          cancelled: jobs.filter((job) => job.status === "cancelled").length,
        };
        setResult(next);
        if (jobs.length === ids.length && jobs.every((job) => terminal.has(job.status))) {
          await onChanged();
          return;
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((current) => `${current ? `${current}；` : ""}${cause instanceof Error ? cause.message : "任务状态读取失败"}`);
    } finally {
      if (jobsController.current === controller) jobsController.current = null;
    }
  }

  useEffect(() => {
    if ((JSON.parse(sourceKey) as string[]).length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.getClientRects().length === 0) return;
      panel.scrollIntoView({ block: "start" });
      panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sourceKey]);

  useEffect(() => {
    const ids = JSON.parse(sourceKey) as string[];
    if (ids.length === 0) return;
    const controller = new AbortController();
    const version = ++prepareVersion.current;
    const timer = window.setTimeout(async () => {
      setPreparing(true); setError(null); setBatches([]); setResult(null);
      try {
        const prepared: Batch[] = [];
        // PDF pages and spreadsheet sheets can each reach the server's
        // 100k source limit. Two always fit the 200k request budget.
        for (let index = 0; index < ids.length; index += 2) {
          const batchIds = ids.slice(index, index + 2);
          const clientKey = crypto.randomUUID();
          const payload = await readPayload(await fetch(`/api/projects/${projectId}/memory/extract`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ phase: "prepare", clientKey, sourceIds: batchIds }), signal: controller.signal,
          })) as { confirmation: Confirmation };
          prepared.push({ sourceIds: batchIds, clientKey, confirmation: payload.confirmation });
        }
        if (version === prepareVersion.current && !controller.signal.aborted) setBatches(prepared);
      } catch (cause) {
        if (!controller.signal.aborted && version === prepareVersion.current) setError(cause instanceof Error ? cause.message : "AI 整理暂时不可用");
      } finally {
        if (!controller.signal.aborted && version === prepareVersion.current) setPreparing(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, sourceKey, retry]);

  async function organize() {
    if (flight.current || batches.length === 0) return;
    flight.current = true; setRunning(true); setError(null);
    let attempted = false;
    const totals: ImportResult = { queued: 0, completed: 0, confirmed: 0, review: 0, duplicates: 0, failed: 0, unknown: 0, cancelled: 0, jobs: [] };
    try {
      for (const batch of batches) {
        // Never silently replace a consent with a changed route or source set.
        if (new Date(batch.confirmation.expiresAt).getTime() <= Date.now()) throw new Error("本次整理确认已过期，请重新读取整理范围后确认。");
        attempted = true;
        const payload = await readPayload(await fetch(`/api/projects/${projectId}/memory/extract`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ phase: "execute", challengeId: batch.confirmation.challengeId, clientKey: batch.clientKey, sourceIds: batch.sourceIds }),
        })) as { job: { id: string; status: string; result?: { confirmedCount?: number; reviewRequiredCount?: number; duplicateCount?: number } | null } };
        totals.jobs.push(payload.job.id);
        totals.queued += 1;
        setResult({ ...totals, jobs: [...totals.jobs] });
      }
      setBatches([]);
    } catch (cause) {
      setResult({ ...totals, jobs: [...totals.jobs] });
      setBatches([]);
      setError(cause instanceof Error ? cause.message : "AI 整理未完成，原始资料已保存。");
    } finally {
      if (totals.jobs.length > 0) {
        await monitorJobs([...totals.jobs]);
      } else if (attempted) {
        // The last response may have been lost after the server accepted it.
        // Refresh local data, but never replay the model request automatically.
        try { await onChanged(); }
        catch { setError((current) => `${current ? `${current}；` : ""}列表刷新失败，返回资料页可查看已保存结果。`); }
      }
      setRunning(false); flight.current = false;
    }
  }

  if (sourceIds.length === 0) return null;
  const routes = [...new Set(batches.map(({ confirmation }) => {
    const route = confirmation.safeSummary.route;
    return [route?.provider?.name ?? route?.provider?.kind ?? "项目配置的模型", route?.model].filter(Boolean).join(" · ");
  }))];
  return <section ref={panelRef} tabIndex={-1} aria-label={translateUi("导入资料自动整理")} className="scroll-mt-5">
    <h3 className="font-semibold text-[var(--app-text)]"><UiText text={"资料已保存，继续交给 AI 整理"} /></h3>
    <p className="mt-2 text-sm leading-6 text-[var(--app-muted)]"><UiText text={"本次"} />{" "}{JSON.parse(sourceKey).length} {" "}<UiText text={"条资料将发送给"} />{routes.length > 0 ? routes.join("、") : <UiText text={"当前项目模型"} />}<UiText text={"。有逐字原文证据的内容会自动形成事实；冲突、改写或不确定内容单独待处理，每条记录保留来源与修改历史。"} /></p>
    {preparing ? <p role="status" className="mt-3 text-sm text-[var(--app-muted)]"><UiText text={"正在核对本次资料范围和模型…"} /></p> : null}
    {batches.length > 0 ? <div className="mt-4 flex justify-end"><button type="button" onClick={() => void organize()} disabled={running} className={modalPrimaryButtonClassName}>{running ? <UiText text={"正在提交后台任务…"} /> : <UiText text={"确认发送并加入队列"} />}</button></div> : null}
    {result ? <div role="status" className="mt-4 text-sm leading-6 text-[var(--app-muted)]"><p><UiText text={"已提交"} />{" "}{result.jobs.length} {" "}<UiText text={"项任务 ·"} />{" "}{result.queued} {" "}<UiText text={"项处理中 ·"} />{" "}{result.completed} {" "}<UiText text={"项完成"} />{result.failed > 0 ? ` · ${result.failed} 项失败` : ""}{result.unknown > 0 ? ` · ${result.unknown} 项待核实` : ""}{result.cancelled > 0 ? ` · ${result.cancelled} 项已取消` : ""}</p>{result.completed > 0 ? <p className="mt-1"><UiText text={"自动形成"} />{" "}{result.confirmed} {" "}<UiText text={"条事实 ·"} />{" "}{result.review} {" "}<UiText text={"条待处理 · 跳过"} />{" "}{result.duplicates} {" "}<UiText text={"条重复记录"} /></p> : null}<div className="mt-2 flex flex-wrap justify-end gap-4"><Link href={buildProjectHref(projectId, "materials", { view: "tasks", from: "materials" })} className="font-semibold underline"><UiText text={"查看任务进度"} /></Link>{result.completed > 0 ? <Link href={buildProjectHref(projectId, "materials", { view: "review", status: "confirmed", focus: "confirmed-facts", from: "materials" })} className="underline"><UiText text={"查看整理结果"} /></Link> : null}{result.review > 0 ? <Link href={buildProjectHref(projectId, "materials", { view: "review", from: "materials" })} className="underline"><UiText text={"处理待核对内容"} /></Link> : null}</div></div> : null}
    {result && result.completed > 0 ? <div className="mt-4 border-t border-[var(--app-border)] pt-4">
      <p className="text-sm leading-6 text-[var(--app-muted)]"><UiText text={"整理结果已保存。需要继续提问时，可打开智能问答；待核对内容可在整理结果栏目处理。"} /></p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Link href={buildProjectQuestionHref(projectId)} className={modalPrimaryButtonClassName}><UiText text={"打开智能问答"} /></Link>
        {result.review > 0 ? <Link href={buildProjectHref(projectId, "materials", { view: "review", from: "materials" })} className="inline-flex min-h-11 items-center px-3 py-2 text-sm font-semibold text-indigo-700 underline"><UiText text={"处理待核对内容"} /></Link> : null}
      </div>
    </div> : null}
    {error ? <div role="alert" className="mt-3 text-sm text-rose-700"><p><UiText text={"原始资料已保留。"} /><UiErrorText text={error} /></p>{!running ? <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 font-semibold underline"><UiText text={"重新核对整理范围"} /></button> : null}<Link href={`/projects/${projectId}/control`} className="ml-4 underline"><UiText text={"查看模型配置"} /></Link></div> : null}
  </section>;
}
