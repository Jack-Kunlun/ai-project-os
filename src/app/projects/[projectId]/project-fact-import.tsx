"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Confirmation = {
  challengeId: string;
  expiresAt: string;
  safeSummary: { route?: { provider?: { name?: string; kind?: string }; model?: string } };
};
type Batch = { sourceIds: string[]; clientKey: string; confirmation: Confirmation };
type ImportResult = { completed: number; confirmed: number; review: number; duplicates: number; jobs: string[] };

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
  const sourceKey = JSON.stringify([...new Set(sourceIds)].sort());
  const [batches, setBatches] = useState<Batch[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [retry, setRetry] = useState(0);
  const flight = useRef(false);
  const prepareVersion = useRef(0);

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
    const totals: ImportResult = { completed: 0, confirmed: 0, review: 0, duplicates: 0, jobs: [] };
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
        if (payload.job.status !== "succeeded") throw new Error("整理任务尚未完成，请查看任务状态后继续；系统不会自动重试模型请求。");
        totals.completed += 1;
        totals.confirmed += payload.job.result?.confirmedCount ?? 0;
        totals.review += payload.job.result?.reviewRequiredCount ?? 0;
        totals.duplicates += payload.job.result?.duplicateCount ?? 0;
        setResult({ ...totals, jobs: [...totals.jobs] });
      }
      setBatches([]);
    } catch (cause) {
      setResult({ ...totals, jobs: [...totals.jobs] });
      setBatches([]);
      setError(cause instanceof Error ? cause.message : "AI 整理未完成，原始资料已保存。");
    } finally {
      // A failed/unknown later batch may follow already committed facts.
      // Refresh the reading surface even when the last HTTP response failed.
      if (attempted) {
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
  return <section aria-label="导入资料自动整理" className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
    <h3 className="font-semibold text-indigo-950">资料已保存，继续交给 AI 整理</h3>
    <p className="mt-2 text-sm leading-6 text-indigo-900">本次 {JSON.parse(sourceKey).length} 条资料将发送给{routes.length > 0 ? routes.join("、") : "当前项目模型"}。有逐字原文证据的内容会自动形成事实；冲突、改写或不确定内容单独待处理，每条记录保留来源与修改历史。</p>
    {preparing ? <p role="status" className="mt-3 text-sm text-indigo-700">正在核对本次资料范围和模型…</p> : null}
    {batches.length > 0 ? <button type="button" onClick={() => void organize()} disabled={running} className="mt-4 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{running ? "AI 正在整理…" : "确认发送并自动整理"}</button> : null}
    {result ? <div role="status" className="mt-4 text-sm leading-6 text-indigo-900">{result.completed > 0 ? <p>自动形成 {result.confirmed} 条事实 · {result.review} 条待处理 · 跳过 {result.duplicates} 条重复记录</p> : <p>本次整理结果尚未核实，请查看任务状态。</p>}<div className="mt-2 flex flex-wrap gap-4"><Link href={`/projects/${projectId}/materials?focus=confirmed-facts`} className="font-semibold underline">查看事实</Link>{result.review > 0 ? <Link href={`/projects/${projectId}/materials/review`} className="font-semibold underline">处理不确定内容</Link> : null}{result.jobs.map((id, index) => <Link key={id} href={`/projects/${projectId}/jobs/${id}`} className="underline">查看整理任务{result.jobs.length > 1 ? ` ${index + 1}` : ""}</Link>)}</div></div> : null}
    {error ? <div role="alert" className="mt-3 text-sm text-rose-700"><p>原始资料已保留。{error}</p>{!running ? <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 font-semibold underline">重新核对整理范围</button> : null}<Link href={`/projects/${projectId}/control`} className="ml-4 underline">查看模型配置</Link></div> : null}
  </section>;
}
