"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AuditDetailDrawer } from "@/app/admin/audit/audit-detail-drawer";
import {
  AUDIT_PAGE_SIZE,
  auditActionLabel,
  auditFilterChips,
  auditReferenceSummary,
  auditResultLabel,
  auditSourceLabel,
  buildAppliedFilters,
  buildAuditQueryString,
  dateParts,
  hasAdvancedFilterValues,
  hasFilters,
  principalLabel,
  resultClass,
  visibleActionOptions,
  visibleResultOptions,
  type AuditEvent,
  type AuditList,
  type AuditFilterInput,
  type FilterValues,
} from "@/app/admin/audit/audit-view-model";
import { SYSTEM_AUDIT_SOURCE_OPTIONS } from "@/lib/system-audit-catalog";

const sources = SYSTEM_AUDIT_SOURCE_OPTIONS;

/**
 * Column widths are declared once so short labels, status pills and the action
 * button keep their own line while the summary column absorbs the remaining
 * space.  The table keeps a local scroll container on narrow viewports instead
 * of forcing the whole page wider.
 */
const COLUMN_WIDTHS = ["w-[10.5rem]", "w-[11rem]", "w-[7rem]", "w-[9rem]", "", "w-[7.5rem]"] as const;

const EMPTY_INPUT: AuditFilterInput = {
  source: "",
  action: "",
  result: "",
  actor: "",
  subject: "",
  projectId: "",
  workspaceId: "",
  userId: "",
  from: "",
  to: "",
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function AdminAuditClient() {
  const [input, setInput] = useState<AuditFilterInput>(EMPTY_INPUT);
  const [appliedFilters, setAppliedFilters] = useState<FilterValues>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [data, setData] = useState<AuditList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const advancedPanelId = useId();

  const visibleActions = visibleActionOptions(input.source);
  const visibleResults = visibleResultOptions(input.source);

  useEffect(() => () => {
    detailRequestRef.current?.abort();
  }, []);

  const queryString = useMemo(
    () => buildAuditQueryString(appliedFilters, cursor, AUDIT_PAGE_SIZE),
    [appliedFilters, cursor],
  );

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

  function setFilter<K extends keyof AuditFilterInput>(key: K, value: AuditFilterInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
  }

  function closeDetail() {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setDetailLoading(false);
    setDetailError(null);
    setSelected(null);
    setDetail(null);
    setDetailTrigger(null);
  }

  function resetListPosition() {
    setHistory([]);
    setCursor(null);
    closeDetail();
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedFilters(buildAppliedFilters(input));
    resetListPosition();
  }

  function resetFilters() {
    setInput(EMPTY_INPUT);
    setAppliedFilters({});
    setAdvancedOpen(false);
    resetListPosition();
  }

  function changeSource(value: string) {
    setInput((current) => {
      if (value === "") return { ...current, source: value };
      const allowedActions = visibleActionOptions(value).map(([optionValue]) => optionValue);
      const allowedResults = visibleResultOptions(value).map(([optionValue]) => optionValue);
      return {
        ...current,
        source: value,
        action: current.action !== "" && !allowedActions.includes(current.action) ? "" : current.action,
        result: current.result !== "" && !allowedResults.includes(current.result) ? "" : current.result,
      };
    });
  }

  function goNext() {
    if (data?.nextCursor === null || data?.nextCursor === undefined) return;
    closeDetail();
    setHistory((items) => [...items, cursor ?? ""]);
    setCursor(data.nextCursor);
  }

  function goPrevious() {
    const previous = history.at(-1);
    if (previous === undefined) return;
    closeDetail();
    setHistory((items) => items.slice(0, -1));
    setCursor(previous === "" ? null : previous);
  }

  async function loadDetail(event: AuditEvent) {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(
        `/api/system/audit/${encodeURIComponent(event.source)}/${encodeURIComponent(event.id)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) throw new Error(await readError(response, "审计详情加载失败"));
      const payload = await response.json() as { event: AuditEvent };
      if (detailRequestRef.current === controller) setDetail(payload.event);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      if (detailRequestRef.current === controller) {
        setDetailError(loadError instanceof Error ? loadError.message : "审计详情加载失败");
      }
    } finally {
      if (detailRequestRef.current === controller) setDetailLoading(false);
    }
  }

  function openDetail(event: AuditEvent, trigger: HTMLElement | null) {
    setSelected(event);
    setDetail(null);
    setDetailTrigger(trigger);
    void loadDetail(event);
  }

  const chips = auditFilterChips(appliedFilters);
  const hasActiveFilters = hasFilters(appliedFilters);
  const advancedActive = hasAdvancedFilterValues(input);
  const page = history.length + 1;

  return <div className="pb-16">
    <section className="rounded-3xl bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-8 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">System audit center</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">审计中心</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">集中查看平台控制面变更证据。这里只展示结构化状态、版本和安全引用，不展示凭据、路径、参数、原因正文或外部请求标识。</p>
        </div>
        {data ? <span className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-slate-200">快照 {dateParts(data.snapshotAt).full}</span> : null}
      </div>
    </section>

    <form onSubmit={applyFilters} className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-semibold text-slate-600">来源<select value={input.source} onChange={(event) => changeSource(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
        <label className="text-xs font-semibold text-slate-600">结果<select value={input.result} onChange={(event) => setFilter("result", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{visibleResults.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
        <label className="text-xs font-semibold text-slate-600">操作者<input value={input.actor} onChange={(event) => setFilter("actor", event.target.value)} placeholder="用户 ID / 登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">主体<input value={input.subject} onChange={(event) => setFilter("subject", event.target.value)} placeholder="用户 ID / 登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
        <label className="text-xs font-semibold text-slate-600">开始时间<input type="datetime-local" value={input.from} onChange={(event) => setFilter("from", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label>
        <label className="text-xs font-semibold text-slate-600">结束时间<input type="datetime-local" value={input.to} onChange={(event) => setFilter("to", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <button type="button" aria-expanded={advancedOpen} aria-controls={advancedPanelId} onClick={() => setAdvancedOpen((open) => !open)} className="whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">
          {advancedOpen ? "收起高级筛选" : `高级筛选${advancedActive ? "（已填写）" : ""}`}
        </button>
        <div id={advancedPanelId} hidden={!advancedOpen} className="mt-4 rounded-2xl bg-slate-50 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-semibold text-slate-600">动作<select value={input.action} onChange={(event) => setFilter("action", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900"><>{visibleActions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</></select></label>
            <label className="text-xs font-semibold text-slate-600">项目 ID<input value={input.projectId} onChange={(event) => setFilter("projectId", event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
            <label className="text-xs font-semibold text-slate-600">工作区 ID<input value={input.workspaceId} onChange={(event) => setFilter("workspaceId", event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
            <label className="text-xs font-semibold text-slate-600">用户 ID<input value={input.userId} onChange={(event) => setFilter("userId", event.target.value)} placeholder="UUID" className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 placeholder:text-slate-400" /></label>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">这两类引用只在排查特定对象时使用。列表按时间倒序，同毫秒内按来源和记录 ID 稳定排序；游标绑定当前筛选快照，修改筛选后重新从第一页开始。</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          <span className="text-xs font-semibold text-slate-500">当前筛选</span>
          {hasActiveFilters ? chips.map((chip) => (
            <span key={chip.key} title={`${chip.label}：${chip.value}`} className="whitespace-nowrap rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{chip.label}：{chip.display}</span>
          )) : <span className="text-xs text-slate-400">未设置，显示全部来源</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={resetFilters} disabled={!hasActiveFilters && !advancedActive} className="whitespace-nowrap rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">重置</button>
          <button type="submit" className="whitespace-nowrap rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">应用筛选</button>
        </div>
      </div>
    </form>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">结构化变更记录</h2>
          <p className="mt-1 text-xs text-slate-500">记录详情不会链接到项目内容、连接配置或动作入口。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-xs text-slate-500">第 {page} 页</span>
          <button type="button" onClick={goPrevious} disabled={history.length === 0 || loading} className="whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">上一页</button>
          <button type="button" onClick={goNext} disabled={data?.nextCursor === null || data?.nextCursor === undefined || loading} className="whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">下一页</button>
        </div>
      </div>
      {loading ? <div role="status" className="px-6 py-16 text-center text-sm text-slate-500">正在读取审计快照…</div> : error ? <div role="status" className="px-6 py-16 text-center"><p className="text-sm font-semibold text-rose-700">{error}</p><p className="mt-2 text-xs text-slate-500">请刷新页面或缩小筛选范围。</p></div> : data?.events.length === 0 ? <div role="status" className="px-6 py-16 text-center text-sm text-slate-500">当前快照没有符合条件的记录。</div> : <div className="overflow-x-auto">
        <table className="w-full min-w-[56.25rem] table-fixed text-left text-sm">
          <caption className="sr-only">平台审计记录，按时间倒序</caption>
          <colgroup>{COLUMN_WIDTHS.map((width, index) => <col key={index} className={width} />)}</colgroup>
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">时间</th>
              <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">来源 / 动作</th>
              <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">结果</th>
              <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">操作者</th>
              <th scope="col" className="px-4 py-3 font-semibold">对象 / 引用摘要</th>
              <th scope="col" className="sticky right-0 z-10 whitespace-nowrap border-l border-slate-100 bg-slate-50 px-4 py-3 font-semibold">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.events.map((auditEvent) => {
              const occurred = dateParts(auditEvent.occurredAt);
              return <tr key={`${auditEvent.source}:${auditEvent.id}`} data-audit-source={auditEvent.source} data-audit-id={auditEvent.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500"><span className="block">{occurred.date}</span><span className="block text-slate-400">{occurred.time}</span></td>
                <td className="px-4 py-4">
                  <p className="whitespace-nowrap text-sm font-semibold text-slate-900">{auditSourceLabel(auditEvent.source)}</p>
                  <p className="mt-1 text-xs text-slate-500">{auditActionLabel(auditEvent.action)}</p>
                </td>
                <td className="px-4 py-4">
                  <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${resultClass(auditEvent.result)}`}>{auditResultLabel(auditEvent.result)}</span>
                </td>
                <td className="px-4 py-4 text-xs text-slate-600"><span className="break-words">{principalLabel(auditEvent.actor)}</span></td>
                <td className="px-4 py-4 text-xs text-slate-600">
                  <p className="break-words text-sm text-slate-800">{principalLabel(auditEvent.subject)}</p>
                  <p className="mt-1 text-slate-400">{auditReferenceSummary(auditEvent.references)}</p>
                </td>
                <td className="sticky right-0 z-10 border-l border-slate-100 bg-white px-4 py-4">
                  <button type="button" onClick={(clickEvent) => openDetail(auditEvent, clickEvent.currentTarget)} className="w-full whitespace-nowrap rounded-xl border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">查看详情</button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
    </section>

    {selected ? (
      <AuditDetailDrawer
        event={selected}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={closeDetail}
        onRetry={() => void loadDetail(selected)}
        returnFocusTo={detailTrigger}
      />
    ) : null}
  </div>;
}
