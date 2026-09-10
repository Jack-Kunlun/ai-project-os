"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  SYSTEM_AUDIT_ACTION_OPTIONS,
  SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE,
  SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE,
  SYSTEM_AUDIT_RESULT_OPTIONS,
  SYSTEM_AUDIT_SOURCE_LABELS,
  SYSTEM_AUDIT_SOURCE_OPTIONS,
  type SystemAuditSource,
} from "@/lib/system-audit-catalog";

const sources = SYSTEM_AUDIT_SOURCE_OPTIONS;
const actions = SYSTEM_AUDIT_ACTION_OPTIONS;
const results = SYSTEM_AUDIT_RESULT_OPTIONS;
const allowedActionsBySource = SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE;
const allowedResultsBySource = SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE;

type AuditEvent = {
  id: string;
  source: string;
  action: string;
  result: string;
  occurredAt: string;
  actor: { kind: string; id: string | null; username: string | null; displayName: string | null };
  subject: { kind: string; id: string | null; username: string | null; displayName: string | null } | null;
  references: Record<string, string>;
  evidence: {
    before: Record<string, string | number | boolean | null>;
    after: Record<string, string | number | boolean | null>;
    versions: Record<string, number | null>;
    safeErrorCode: string | null;
    reasonRecorded: boolean;
  };
};

type AuditList = { events: AuditEvent[]; nextCursor: string | null; snapshotAt: string; pageSize: number };
type FilterValues = Readonly<Record<string, string>>;

const sourceLabels: ReadonlyMap<string, string> = new Map(Object.entries(SYSTEM_AUDIT_SOURCE_LABELS));

function optionLabel(options: ReadonlyArray<readonly [string, string]>, value: string): string {
  return options.find(([key]) => key === value)?.[1] ?? value;
}

function sourceActions(value: string): readonly string[] {
  return value === "" ? [] : allowedActionsBySource[value as SystemAuditSource] ?? [];
}

function sourceResults(value: string): readonly string[] {
  return value === "" ? [] : allowedResultsBySource[value as SystemAuditSource] ?? [];
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function principalLabel(value: AuditEvent["actor"] | null): string {
  if (value === null) return "—";
  if (value.kind === "system") return "系统流程";
  if (value.kind === "unrecorded") return "未记录身份";
  return value.displayName ?? value.username ?? value.id ?? "未记录身份";
}

function valuesLabel(values: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "无变化";
  return entries.map(([key, value]) => `${key}=${value === null ? "—" : String(value)}`).join(" · ");
}

function resultClass(value: string): string {
  if (value === "applied" || value === "restored") return "bg-emerald-50 text-emerald-700";
  if (value === "pending") return "bg-amber-50 text-amber-700";
  if (value === "rejected" || value === "revoked" || value === "disabled" || value === "failed") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function AdminAuditClient() {
  const [source, setSource] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [actor, setActor] = useState("");
  const [subject, setSubject] = useState("");
  const [projectId, setProjectId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<FilterValues>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [data, setData] = useState<AuditList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);

  const visibleActions = source === ""
    ? actions
    : actions.filter(([value]) => value === "" || sourceActions(source).includes(value) === true);
  const visibleResults = source === ""
    ? results
    : results.filter(([value]) => value === "" || sourceResults(source).includes(value) === true);

  useEffect(() => () => {
    detailRequestRef.current?.abort();
  }, []);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(appliedFilters)) params.set(key, value);
    params.set("pageSize", "20");
    if (cursor !== null) params.set("cursor", cursor);
    return params.toString();
  }, [appliedFilters, cursor]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/system/audit?${queryString}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await readError(response, "审计记录加载失败"));
        const payload = await response.json() as AuditList;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "审计记录加载失败");
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
    const nextFilters: Record<string, string> = {};
    for (const [key, value] of Object.entries({ source, action, result, actor, subject, projectId, workspaceId, userId })) {
      if (value !== "") nextFilters[key] = value;
    }
    if (from !== "") nextFilters.from = new Date(from).toISOString();
    if (to !== "") nextFilters.to = new Date(to).toISOString();
    setAppliedFilters(nextFilters);
    setHistory([]);
    setCursor(null);
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setSelected(null);
  }

  function changeSource(value: string) {
    setSource(value);
    if (value !== "" && action !== "" && !sourceActions(value).includes(action)) setAction("");
    if (value !== "" && result !== "" && !sourceResults(value).includes(result)) setResult("");
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

  async function openDetail(event: AuditEvent) {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setSelected(event);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/system/audit/${encodeURIComponent(event.source)}/${encodeURIComponent(event.id)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await readError(response, "审计详情加载失败"));
      const payload = await response.json() as { event: AuditEvent };
      if (detailRequestRef.current === controller) setSelected(payload.event);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      if (detailRequestRef.current === controller) setDetailError(loadError instanceof Error ? loadError.message : "审计详情加载失败");
    } finally {
      if (detailRequestRef.current === controller) setDetailLoading(false);
    }
  }

  function closeDetail() {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setDetailLoading(false);
    setDetailError(null);
    setSelected(null);
  }

  return <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-8 lg:px-10">
    <section className="rounded-3xl bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-8 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">System audit center</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">审计中心</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">集中查看平台控制面变更证据。这里只展示结构化状态、版本和安全引用，不展示凭据、路径、参数、原因正文或外部请求标识。</p>
        </div>
        {data ? <span className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-slate-200">快照 {dateLabel(data.snapshotAt)}</span> : null}
      </div>
    </section>

    <form onSubmit={applyFilters} className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
        <label className="text-xs font-semibold text-slate-600">来源<select value={source} onChange={(event) => changeSource(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
        <label className="text-xs font-semibold text-slate-600">动作<select value={action} onChange={(event) => setAction(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{visibleActions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
        <label className="text-xs font-semibold text-slate-600">结果<select value={result} onChange={(event) => setResult(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{visibleResults.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
        <label className="text-xs font-semibold text-slate-600">操作者<input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="用户 ID / 登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">主体<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="用户 ID / 登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">工作区 ID<input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">用户 ID<input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">开始时间<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label>
        <label className="text-xs font-semibold text-slate-600">结束时间<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs leading-5 text-slate-500">按时间倒序，同毫秒内按来源和记录 ID 稳定排序；游标绑定当前筛选快照。</p>
        <button type="submit" className="rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">应用筛选</button>
      </div>
    </form>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
        <div><h2 className="text-lg font-semibold text-slate-950">结构化变更记录</h2><p className="mt-1 text-xs text-slate-500">记录详情不会链接到项目内容、连接配置或动作入口。</p></div>
        <div className="flex items-center gap-2"><button type="button" onClick={goPrevious} disabled={history.length === 0 || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button><button type="button" onClick={goNext} disabled={data?.nextCursor === null || data?.nextCursor === undefined || loading} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button></div>
      </div>
      {loading ? <div className="px-6 py-16 text-center text-sm text-slate-500">正在读取审计快照…</div> : error ? <div className="px-6 py-16 text-center"><p className="text-sm font-semibold text-rose-700">{error}</p><p className="mt-2 text-xs text-slate-500">请刷新页面或缩小筛选范围。</p></div> : data?.events.length === 0 ? <div className="px-6 py-16 text-center text-sm text-slate-500">当前快照没有符合条件的记录。</div> : <div className="overflow-x-auto"><table className="min-w-[940px] w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-6 py-3 font-semibold">时间</th><th className="px-6 py-3 font-semibold">来源 / 动作</th><th className="px-6 py-3 font-semibold">结果</th><th className="px-6 py-3 font-semibold">操作者</th><th className="px-6 py-3 font-semibold">主体 / 引用</th><th className="px-6 py-3 font-semibold">查看</th></tr></thead><tbody className="divide-y divide-slate-100">{data?.events.map((event) => <tr key={`${event.source}:${event.id}`} className="align-top"><td className="whitespace-nowrap px-6 py-4 text-xs text-slate-500">{dateLabel(event.occurredAt)}</td><td className="px-6 py-4"><p className="font-semibold text-slate-900">{sourceLabels.get(event.source) ?? event.source}</p><p className="mt-1 text-xs text-slate-500">{optionLabel(actions, event.action)}</p></td><td className="px-6 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${resultClass(event.result)}`}>{optionLabel(results, event.result)}</span></td><td className="px-6 py-4 text-xs text-slate-600">{principalLabel(event.actor)}</td><td className="max-w-sm px-6 py-4 text-xs text-slate-600"><p>{principalLabel(event.subject)}</p><p className="mt-1 break-all text-slate-400">{Object.entries(event.references).map(([key, value]) => `${key}: ${value}`).join(" · ") || "无安全引用"}</p></td><td className="px-6 py-4"><button type="button" onClick={() => void openDetail(event)} className="rounded-xl border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">查看详情</button></td></tr>)}</tbody></table></div>}
    </section>

    {selected ? <div className="mt-6 rounded-3xl border border-indigo-100 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Audit detail</p><h2 className="mt-2 text-lg font-semibold text-slate-950">{sourceLabels.get(selected.source) ?? selected.source} · {optionLabel(actions, selected.action)}</h2><p className="mt-1 break-all text-xs text-slate-400">记录 ID：{selected.id}</p></div><button type="button" onClick={closeDetail} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">关闭详情</button></div>{detailLoading ? <p className="mt-5 text-sm text-slate-500">正在读取详情…</p> : detailError ? <p className="mt-5 text-sm text-rose-700">{detailError}</p> : <div className="mt-5 grid gap-4 md:grid-cols-2"><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">前状态</p><p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(selected.evidence.before)}</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">后状态</p><p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(selected.evidence.after)}</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">版本证据</p><p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(selected.evidence.versions)}</p></div><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">安全说明</p><p className="mt-2 text-sm text-slate-800">操作者：{principalLabel(selected.actor)} · 主体：{principalLabel(selected.subject)} · 安全错误码：{selected.evidence.safeErrorCode ?? "未记录"} · 原因正文：{selected.evidence.reasonRecorded ? "已记录但不展示" : "未记录"}</p></div></div>}</div> : null}
  </div>;
}
