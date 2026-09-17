"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS,
  SYSTEM_FAILURE_INBOX_LIFECYCLES,
  SYSTEM_FAILURE_INBOX_SOURCE_LABELS,
  SYSTEM_FAILURE_INBOX_SOURCES,
  type SystemFailureInboxEntry,
  type SystemFailureInboxLifecycle,
  type SystemFailureInboxList,
  type SystemFailureInboxSource,
} from "@/lib/system-failure-inbox-contract";

const lifecycleOptions = SYSTEM_FAILURE_INBOX_LIFECYCLES;
const sourceOptions = SYSTEM_FAILURE_INBOX_SOURCES;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未取得" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function lifecycleTone(value: SystemFailureInboxLifecycle): string {
  if (value === "requires_reconciliation") return "bg-amber-50 text-amber-800";
  if (value === "requires_owner_review") return "bg-orange-50 text-orange-800";
  return "bg-rose-50 text-rose-700";
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "失败收件箱加载失败";
  } catch {
    return "失败收件箱加载失败";
  }
}

export function AdminFailureInboxClient() {
  const [source, setSource] = useState<SystemFailureInboxSource | "">("");
  const [lifecycle, setLifecycle] = useState<SystemFailureInboxLifecycle | "">("");
  const [appliedFilters, setAppliedFilters] = useState<Readonly<{ source?: SystemFailureInboxSource; lifecycle?: SystemFailureInboxLifecycle }>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [data, setData] = useState<SystemFailureInboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (appliedFilters.source !== undefined) params.set("source", appliedFilters.source);
    if (appliedFilters.lifecycle !== undefined) params.set("lifecycle", appliedFilters.lifecycle);
    params.set("pageSize", "20");
    if (cursor !== null) params.set("cursor", cursor);
    return params.toString();
  }, [appliedFilters, cursor]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/admin/operations/failures?${queryString}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await readError(response));
        const payload = await response.json() as SystemFailureInboxList;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "失败收件箱加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [queryString]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedFilters({
      ...(source === "" ? {} : { source }),
      ...(lifecycle === "" ? {} : { lifecycle }),
    });
    setCursor(null);
    setHistory([]);
  }

  function goNext() {
    if (data?.nextCursor === null || data?.nextCursor === undefined) return;
    setHistory((items) => [...items, cursor ?? ""]);
    setCursor(data.nextCursor);
  }

  function goPrevious() {
    const previous = history.at(-1);
    if (previous === undefined) return;
    setHistory((items) => items.slice(0, -1));
    setCursor(previous === "" ? null : previous);
  }

  return <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-8 lg:px-10">
    <section className="rounded-3xl bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-8 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Failure inbox</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">失败与待对账收件箱</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">这里只读汇总平台待核对、Worker / 后台任务、索引、个人连接、自动化和受控动作异常。业务责任方在用户侧处理，管理员后台不提供业务详情入口；每项只有一个安全下一步，不显示个人身份、凭据、工具定义、参数或载荷。</p>
        </div>
        {data ? <span className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-slate-200">测量于 {formatDate(data.observedAt)}</span> : null}
      </div>
    </section>

    <form onSubmit={applyFilters} className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600">来源<select value={source} onChange={(event) => setSource(event.target.value as SystemFailureInboxSource | "")} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><option value="">全部来源</option>{sourceOptions.map((value) => <option key={value} value={value}>{SYSTEM_FAILURE_INBOX_SOURCE_LABELS[value]}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">状态<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as SystemFailureInboxLifecycle | "")} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><option value="">全部状态</option>{lifecycleOptions.map((value) => <option key={value} value={value}>{SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS[value]}</option>)}</select></label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs leading-5 text-slate-500">近 {data?.window.days ?? 7} 天终态失败，当前待对账状态不因窗口消失；责任人复核项按实时状态返回。排序按发生时间、来源和不透明记录标识稳定倒序；游标绑定当前筛选。</p>
        <button type="submit" className="rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">应用筛选</button>
      </div>
    </form>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white shadow-sm" aria-labelledby="failure-inbox-list-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
        <div><h2 id="failure-inbox-list-title" className="text-lg font-semibold text-slate-950">安全异常集合</h2><p className="mt-1 text-xs text-slate-500">实时测量结果，不承诺跨页严格历史快照；状态已解决时允许在下一页消失。</p></div>
        <div className="flex items-center gap-2"><button type="button" onClick={goPrevious} disabled={history.length === 0 || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button><button type="button" onClick={goNext} disabled={data?.nextCursor === null || data?.nextCursor === undefined || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button></div>
      </div>
      {data && data.partialSources.length > 0 ? <aside role="status" className="mx-4 mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900 sm:mx-6">安全查询上限提示：{data.partialSources.map((value) => SYSTEM_FAILURE_INBOX_SOURCE_LABELS[value]).join("、")} 仅展示受控上限内的部分结果，不是完整清单；请结合实时测量时间继续复核。</aside> : null}
      <div aria-live="polite">
        {loading ? <div className="px-6 py-16 text-center text-sm text-slate-500">正在读取安全异常…</div> : error ? <div role="alert" className="px-6 py-16 text-center"><p className="text-sm font-semibold text-rose-700">{error}</p><p className="mt-2 text-xs text-slate-500">请刷新页面或缩小筛选范围。</p></div> : data?.entries.length === 0 ? <div className="px-6 py-16 text-center text-sm text-slate-500">当前测量没有符合条件的异常。</div> : <div className="grid gap-4 p-4 sm:p-6">{data?.entries.map((entry) => <FailureEntryCard key={entry.entryId} entry={entry} />)}</div>}
      </div>
    </section>
  </div>;
}

function FailureEntryCard({ entry }: { entry: SystemFailureInboxEntry }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-5" tabIndex={0} aria-labelledby={`failure-entry-${entry.entryId}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">{SYSTEM_FAILURE_INBOX_SOURCE_LABELS[entry.source]}</p>
        <h3 id={`failure-entry-${entry.entryId}`} className="mt-2 text-base font-semibold text-slate-950">{entry.responsibility}</h3>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${lifecycleTone(entry.lifecycle)}`}>{SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS[entry.lifecycle]}</span>
    </div>
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-xs font-semibold text-slate-500">发生时间</dt><dd className="mt-1 text-slate-800">{formatDate(entry.occurredAt)}</dd></div>
      <div><dt className="text-xs font-semibold text-slate-500">安全错误码</dt><dd className="mt-1 font-mono text-xs text-slate-800">{entry.safeErrorCode}</dd></div>
      <div><dt className="text-xs font-semibold text-slate-500">责任范围</dt><dd className="mt-1 text-slate-800">{entry.responsibility}</dd></div>
    </dl>
    <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-sm leading-6 sm:grid-cols-2">
      <div><p className="text-xs font-semibold text-slate-500">安全原因</p><p className="mt-1 text-slate-700">{entry.reason}</p></div>
      <div><p className="text-xs font-semibold text-slate-500">唯一下一步</p><p className="mt-1 text-slate-700">{entry.nextStep}</p>{entry.destination ? <Link href={entry.destination} className="mt-3 inline-flex rounded-xl bg-indigo-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">打开安全入口</Link> : <p className="mt-3 text-xs text-slate-500">当前管理员没有可安全打开的详情入口。</p>}</div>
    </div>
  </article>;
}
