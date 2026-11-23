"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useAppearance } from "@/components/appearance-provider";
import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import styles from "../support-pages.module.css";
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
  const { language, t } = useAppearance();
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
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const notificationCursorByIdRef = useRef<ReadonlyMap<string, string | null>>(new Map());
  const hasAppendedPage = useRef(false);
  const openingIdRef = useRef<string | null>(null);

  const reload = useCallback(async (options: Readonly<{ append?: boolean; cursorOverride?: string | null }> = {}) => {
    const append = options.append === true;
    const requestCursor = options.cursorOverride === undefined ? cursor : options.cursorOverride;
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setLoadingMore(append);
    setLoading(!append);
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
      hasAppendedPage.current = append;
      setNextCursor(payload.nextCursor);
      setUnreadCount(Number.isSafeInteger(payload.unreadCount) ? Math.max(0, payload.unreadCount) : 0);
      setPendingCount(Number.isSafeInteger(payload.pendingCount) ? Math.max(0, payload.pendingCount) : 0);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(t(cause instanceof Error ? cause.message : "通知加载失败"));
    } finally {
      if (sequence === requestSequence.current) {
        activeController.current = null;
        setLoadingMore(false);
        setLoading(false);
      }
    }
  }, [cursor, filter, t]);

  useEffect(() => {
    const initial = window.setTimeout(() => void reload(), 0);
    const interval = window.setInterval(() => {
      // Poll only the first page and never replace a paginated view or an
      // item currently being acknowledged.
      if (cursor === null && !hasAppendedPage.current && activeController.current === null && openingIdRef.current === null) void reload();
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
    if (next === filter) return;
    setFilter(next);
    setCursor(null);
    notificationCursorByIdRef.current = new Map();
    hasAppendedPage.current = false;
    setLoading(true);
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
      setError(t(cause instanceof Error ? cause.message : "通知状态更新失败"));
    } finally {
      openingIdRef.current = null;
      setOpeningId(null);
    }
  }

  async function markAllRead(): Promise<void> {
    if (markingAllRead || unreadCount === 0 || openingId !== null) return;
    setMarkingAllRead(true);
    try {
      const response = await fetch("/api/notifications/read-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(await responseError(response, "通知状态更新失败"));
      window.dispatchEvent(new CustomEvent("ai-project-os:notifications-changed"));
      setError(null);
      if (filter === "unread" && cursor !== null) setCursor(null);
      else await reload();
    } catch (cause) {
      setError(t(cause instanceof Error ? cause.message : "通知状态更新失败"));
    } finally {
      setMarkingAllRead(false);
    }
  }

  const emptyMessage = filter === "unread" ? "当前没有未读通知。切换到“全部”可查看历史记录。" : filter === "pending" ? "当前没有待处理事项。状态变化后会在这里实时更新。" : filter === "system" ? "当前没有系统通知。" : "还没有活动记录。耗时任务完成、失败或需要人工确认后会出现在这里。";
  return <main className={styles.page}><AppHeader username={username} active="notifications" isSystemAdmin={isSystemAdmin} /><div data-page-content className={styles.content}><section className={styles.pageHeader}><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"通知中心"} /></p><h1 className={`${styles.pageTitle} mt-2`}><UiText text={"通知中心"} /></h1><p className="mt-2 max-w-2xl text-sm leading-6 text-app-muted"><UiText text={"仓库扫描、记忆索引、图片识别、AI 调查、动作审批和自动化结果集中在这里；打开记录后仍会保留在历史中。"} /></p></div><div className="flex flex-wrap items-center gap-3"><span className="rounded-full bg-app-accent-soft px-3 py-1.5 text-xs font-semibold text-app-link">{unreadCount} <UiText text={"条未读"} /></span><button type="button" onClick={() => void markAllRead()} disabled={markingAllRead || unreadCount === 0 || openingId !== null} aria-busy={markingAllRead} className="app-button-secondary flex min-h-10 items-center justify-center rounded-control border px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={markingAllRead ? "正在标记已读…" : "全部标记为已读"} /></button></div></section>
      <nav className={styles.notificationTabs} aria-label={t("活动筛选")}>{([ ["all", "全部"], ["unread", "未读"], ["pending", "待处理"], ["system", "系统"] ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => changeFilter(value)} aria-pressed={filter === value} className={styles.notificationTab}><UiText text={label} />{value === "pending" && pendingCount > 0 ? ` ${pendingCount}` : ""}</button>)}</nav>
      {error ? <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><span><UiErrorText text={error} /></span><button type="button" onClick={() => void reload()} className="font-semibold underline underline-offset-4"><UiText text={"重试"} /></button></div> : null}
      <section className="mt-6 space-y-3" aria-live="polite">{loading && notifications.length === 0 ? [1, 2, 3].map((item) => <div key={item} className="h-32 animate-pulse rounded-control bg-app-surface" />) : notifications.length === 0 ? <div className="rounded-panel border border-dashed border-app-border bg-app-surface px-6 py-16 text-center text-sm text-app-muted"><UiText text={emptyMessage} /></div> : notifications.map((item) => <article id={`notification-${item.id}`} key={item.id} className={["app-panel", (`scroll-mt-28 rounded-panel border bg-app-surface p-5 transition ${item.readAt === null ? "app-panel-accent" : "border-app-border"}`)].filter(Boolean).join(' ')}><div className="flex items-start gap-4"><span aria-hidden="true" className={`mt-1 h-3 w-3 shrink-0 rounded-full ${item.readAt !== null ? "bg-app-surface-soft" : item.severity === "error" ? "bg-app-danger" : item.severity === "warning" ? "bg-app-warning" : item.severity === "success" ? "bg-app-success" : "bg-app-accent"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className={`font-semibold ${item.readAt !== null ? "text-app-muted" : "text-app-text"}`}>{item.title}</h2><time className="text-xs text-app-muted">{new Date(item.createdAt).toLocaleString(language === "en" ? "en-US" : "zh-CN")}</time></div><p className="mt-2 text-sm leading-6 text-app-muted">{item.body}</p><div className="mt-4 flex flex-wrap items-center gap-3">{item.destination ? <button type="button" onClick={() => void open(item)} disabled={openingId !== null} className="app-button-primary flex min-h-10 items-center justify-center rounded-control px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={openingId === item.id ? "打开中…" : "查看详情"} /></button> : <button type="button" onClick={() => void open(item)} disabled={openingId !== null || item.readAt !== null} className="app-button-secondary flex min-h-10 items-center justify-center rounded-control border px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={openingId === item.id ? "处理中…" : item.readAt !== null ? "已读" : "确认通知已读"} /></button>}{item.actionState === "pending" ? <span className="text-xs font-semibold text-app-warning-ink"><UiText text={"待处理"} /></span> : item.actionState === "invalid" ? <span className="text-xs text-app-muted"><UiText text={"已失效"} /></span> : item.actionState === "resolved" ? <span className="text-xs text-app-muted"><UiText text={"已结束"} /></span> : null}{item.readAt !== null ? <span className="text-xs text-app-muted"><UiText text={"已读"} /></span> : null}</div></div></div></article>)}</section>
      {nextCursor !== null ? <button type="button" onClick={() => { const next = nextCursor; void reload({ append: true, cursorOverride: next }); }} disabled={loadingMore || openingId !== null} className="app-button-secondary mt-6 flex min-h-11 w-full items-center justify-center rounded-control border px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={loadingMore ? "加载中…" : "加载更早记录"} /></button> : null}
    </div></main>;
}
