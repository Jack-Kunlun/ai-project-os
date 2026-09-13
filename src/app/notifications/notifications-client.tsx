"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { notificationCursorForId, rememberNotificationPageCursor } from "@/lib/notification-navigation";

type NotificationFilter = "all" | "unread" | "pending" | "system";
type Notification = {
  id: string;
  kind: string;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  actionHref: string | null;
  readAt: string | null;
  createdAt: string;
  actionState: "none" | "pending" | "resolved" | "invalid";
  destination: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

function parseFilter(value: string | null): NotificationFilter {
  return value === "unread" || value === "pending" || value === "system" ? value : "all";
}

function parseSafeCursor(value: string | null): string | null {
  return value !== null && CURSOR_PATTERN.test(value) ? value : null;
}

function parseFocus(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value : null;
}

export function notificationDetailHref(href: string, filter: NotificationFilter, cursor: string | null, focus: string | null): string | null {
  try {
    const target = new URL(href, window.location.origin);
    if (target.origin !== window.location.origin || !/^\/(?!\/)[A-Za-z0-9/_-]{0,1023}$/u.test(target.pathname)) return null;
    const supportsReturnContext = /^\/projects\/[^/]+\/(?:actions|jobs\/[^/]+|automations)$/u.test(target.pathname);
    const params = new URLSearchParams();
    const actionId = target.searchParams.get("action");
    if (supportsReturnContext && actionId !== null && UUID_PATTERN.test(actionId)) params.set("action", actionId);
    const runId = target.searchParams.get("run");
    if (supportsReturnContext && runId !== null && UUID_PATTERN.test(runId)) params.set("run", runId);
    // Only detail screens with an explicit return handler receive the finite
    // from=notifications context. Drop arbitrary stored query keys such as
    // returnTo before adding this context.
    if (supportsReturnContext) {
      params.set("from", "notifications");
      params.set("view", filter);
      if (cursor !== null && CURSOR_PATTERN.test(cursor)) params.set("cursor", cursor);
      if (focus !== null && UUID_PATTERN.test(focus)) params.set("focus", focus);
    }
    const query = params.toString();
    return `${target.pathname}${query ? `?${query}` : ""}${target.hash}`;
  } catch {
    return null;
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function NotificationsClient({ username, isSystemAdmin = false }: { username: string; isSystemAdmin?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<NotificationFilter>(() => parseFilter(searchParams.get("view")));
  const [cursor, setCursor] = useState<string | null>(() => parseSafeCursor(searchParams.get("cursor")));
  const focusId = parseFocus(searchParams.get("focus"));
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const notificationCursorByIdRef = useRef<ReadonlyMap<string, string | null>>(new Map());
  const nextCursorRef = useRef<string | null>(null);
  const openingIdRef = useRef<string | null>(null);

  const reload = useCallback(async (options: Readonly<{ append?: boolean; cursorOverride?: string | null }> = {}) => {
    const append = options.append === true;
    const requestCursor = options.cursorOverride === undefined ? cursor : options.cursorOverride;
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const query = new URLSearchParams({ filter, limit: "20" });
      if (requestCursor !== null) query.set("cursor", requestCursor);
      const response = await fetch(`/api/notifications?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "通知加载失败"));
      const payload = await response.json() as { notifications: Notification[]; unreadCount: number; pendingCount: number; nextCursor: string | null };
      if (sequence !== requestSequence.current) return;
      setNotifications((current) => append ? [...current, ...payload.notifications] : payload.notifications);
      notificationCursorByIdRef.current = rememberNotificationPageCursor(
        append ? notificationCursorByIdRef.current : new Map(),
        payload.notifications,
        requestCursor,
      );
      nextCursorRef.current = payload.nextCursor;
      setNextCursor(payload.nextCursor);
      setUnreadCount(Number.isSafeInteger(payload.unreadCount) ? Math.max(0, payload.unreadCount) : 0);
      setPendingCount(Number.isSafeInteger(payload.pendingCount) ? Math.max(0, payload.pendingCount) : 0);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : "通知加载失败");
    } finally {
      if (sequence === requestSequence.current) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [cursor, filter]);

  useEffect(() => {
    const initial = window.setTimeout(() => void reload(), 0);
    const interval = window.setInterval(() => {
      // Poll only the first page and never replace a paginated view or an
      // item currently being acknowledged.
      if (cursor === null && nextCursorRef.current === null && openingIdRef.current === null) void reload();
    }, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [cursor, filter, reload]);

  useEffect(() => {
    if (focusId === null) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`notification-${focusId}`);
      if (!target) return;
      const previousTabIndex = target.getAttribute("tabindex");
      if (previousTabIndex === null) target.setAttribute("tabindex", "-1");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
      window.setTimeout(() => {
        if (previousTabIndex === null) target.removeAttribute("tabindex");
      }, 1_000);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, notifications]);

  function changeFilter(next: NotificationFilter): void {
    setFilter(next);
    setCursor(null);
    notificationCursorByIdRef.current = new Map();
    nextCursorRef.current = null;
    setNextCursor(null);
    setNotifications([]);
    setError(null);
  }

  async function open(item: Notification): Promise<void> {
    if (openingIdRef.current !== null) return;
    openingIdRef.current = item.id;
    setOpeningId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/notifications/${item.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const payload = await response.json().catch(() => null) as { notification?: Notification; error?: { message?: string } } | null;
      if (!response.ok || payload?.notification === undefined) throw new Error(payload?.error?.message ?? "通知状态更新失败");
      const opened = payload.notification;
      if (item.readAt === null) setUnreadCount((current) => Math.max(0, current - 1));
      setNotifications((current) => filter === "unread" ? current.filter((candidate) => candidate.id !== item.id) : current.map((candidate) => candidate.id === item.id ? { ...candidate, readAt: opened.readAt } : candidate));
      window.dispatchEvent(new CustomEvent("ai-project-os:notifications-changed"));
      if (opened.destination !== null) {
        const detailCursor = notificationCursorForId(notificationCursorByIdRef.current, item.id, cursor);
        const destination = notificationDetailHref(opened.destination, filter, detailCursor, item.id);
        if (destination !== null) router.push(destination);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "通知状态更新失败");
    } finally {
      openingIdRef.current = null;
      setOpeningId(null);
    }
  }

  const emptyMessage = filter === "unread" ? "当前没有未读通知。切换到“全部”可查看历史记录。" : filter === "pending" ? "当前没有待处理事项。状态变化后会在这里实时更新。" : filter === "system" ? "当前没有系统通知。" : "还没有活动记录。耗时任务完成、失败或需要人工确认后会出现在这里。";
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="notifications" isSystemAdmin={isSystemAdmin} /><div className="mx-auto max-w-5xl px-5 py-8 sm:px-10 sm:py-10"><section className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Activity inbox</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">活动记录</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">仓库扫描、记忆索引、图片识别、AI 调查、动作审批和自动化结果集中在这里；打开记录后仍会保留在历史中。</p></div><span className="rounded-full bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700">{unreadCount} 条未读</span></section>
      <nav className="mt-7 flex max-w-full gap-2 overflow-x-auto rounded-2xl bg-slate-100 p-1" aria-label="活动筛选">{([ ["all", "全部"], ["unread", "未读"], ["pending", `待处理${pendingCount > 0 ? ` ${pendingCount}` : ""}`], ["system", "系统"] ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => changeFilter(value)} aria-pressed={filter === value} className={`min-h-10 shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${filter === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-700 hover:bg-white/70"}`}>{label}</button>)}</nav>
      {error ? <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void reload()} className="font-semibold underline underline-offset-4">重试</button></div> : null}
      <section className="mt-6 space-y-3" aria-live="polite">{loading && notifications.length === 0 ? [1, 2, 3].map((item) => <div key={item} className="h-32 animate-pulse rounded-3xl bg-white shadow-sm" />) : notifications.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">{emptyMessage}</div> : notifications.map((item) => <article id={`notification-${item.id}`} key={item.id} className={`scroll-mt-28 rounded-3xl border bg-white p-5 shadow-sm transition ${item.readAt === null ? "border-indigo-200" : "border-slate-200"}`}><div className="flex items-start gap-4"><span aria-hidden="true" className={`mt-1 h-3 w-3 shrink-0 rounded-full ${item.readAt !== null ? "bg-slate-300" : item.severity === "error" ? "bg-rose-500" : item.severity === "warning" ? "bg-amber-500" : item.severity === "success" ? "bg-emerald-500" : "bg-indigo-500"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className={`font-semibold ${item.readAt !== null ? "text-slate-600" : "text-slate-900"}`}>{item.title}</h2><time className="text-xs text-slate-600">{new Date(item.createdAt).toLocaleString("zh-CN")}</time></div><p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p><div className="mt-4 flex flex-wrap items-center gap-3">{item.destination ? <button type="button" onClick={() => void open(item)} disabled={openingId !== null} className="flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{openingId === item.id ? "打开中…" : "查看详情"}</button> : <button type="button" onClick={() => void open(item)} disabled={openingId !== null || item.readAt !== null} className="flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">{openingId === item.id ? "处理中…" : item.readAt !== null ? "已读" : "知道了"}</button>}{item.actionState === "pending" ? <span className="text-xs font-semibold text-amber-700">待处理</span> : item.actionState === "invalid" ? <span className="text-xs text-slate-500">已失效</span> : item.actionState === "resolved" ? <span className="text-xs text-slate-500">已结束</span> : null}{item.readAt !== null ? <span className="text-xs text-slate-600">已读</span> : null}</div></div></div></article>)}</section>
      {nextCursor !== null ? <button type="button" onClick={() => { const next = nextCursor; void reload({ append: true, cursorOverride: next }); }} disabled={loadingMore || openingId !== null} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-50">{loadingMore ? "加载中…" : "加载更早记录"}</button> : null}
    </div></main>;
}
