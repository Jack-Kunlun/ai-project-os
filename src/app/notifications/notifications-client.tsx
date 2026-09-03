"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";

type Notification = { id: string; severity: "info" | "success" | "warning" | "error"; title: string; body: string; actionHref: string | null; readAt: string | null; createdAt: string };

function notificationDetailHref(href: string): string {
  const hashIndex = href.indexOf("#");
  const pathAndQuery = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  return `${pathAndQuery}${pathAndQuery.includes("?") ? "&" : "?"}from=notifications${hash}`;
}

export function NotificationsClient({ username }: { username: string }) {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]); const [unreadCount, setUnreadCount] = useState(0); const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const reload = useCallback(async () => { try { const response = await fetch("/api/notifications", { cache: "no-store" }); if (!response.ok) throw new Error("通知加载失败"); const payload = await response.json() as { notifications: Notification[]; unreadCount: number }; setNotifications(payload.notifications); setUnreadCount(payload.unreadCount); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "通知加载失败"); } }, []);
  useEffect(() => { const initial = window.setTimeout(() => void reload(), 0); const interval = window.setInterval(() => void reload(), 15_000); return () => { window.clearTimeout(initial); window.clearInterval(interval); }; }, [reload]);
  async function open(item: Notification): Promise<void> {
    if (openingId !== null) return;
    setOpeningId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/notifications/${item.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const payload = await response.json().catch(() => null) as { notification?: Notification; error?: { message?: string } } | null;
      if (!response.ok || payload?.notification === undefined) {
        throw new Error(payload?.error?.message ?? "通知状态更新失败");
      }

      // Remove it immediately from this unread queue. The event lets every
      // mounted bell refresh without waiting for its polling interval.
      setNotifications((current) => current.filter((candidate) => candidate.id !== item.id));
      setUnreadCount((current) => Math.max(0, current - 1));
      window.dispatchEvent(new CustomEvent("ai-project-os:notifications-changed"));

      const actionHref = payload.notification.actionHref;
      if (actionHref !== null) router.push(notificationDetailHref(actionHref));
    } catch (cause) {
      // Keep the notification visible when the acknowledgement fails.
      setError(cause instanceof Error ? cause.message : "通知状态更新失败");
    } finally {
      setOpeningId(null);
    }
  }

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="notifications" /><div className="mx-auto max-w-5xl px-6 py-10 sm:px-10"><section className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Activity inbox</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">通知中心</h1><p className="mt-3 text-sm text-slate-600">仓库扫描、记忆索引、图片识别、AI 调查、动作审批和自动化结果集中在这里；任务完成或失败后可直接进入详情。</p></div><span className="rounded-full bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700">{unreadCount} 条未读</span></section>{error ? <p role="alert" className="mt-6 rounded-2xl bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}<section className="mt-8 space-y-3">{notifications.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">当前没有未读通知。耗时任务完成、失败或需要人工确认后会出现在这里。</div> : notifications.map((item) => <article key={item.id} className="rounded-3xl border border-indigo-200 bg-white p-5 shadow-sm"><div className="flex items-start gap-4"><span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${item.severity === "error" ? "bg-rose-500" : item.severity === "warning" ? "bg-amber-500" : item.severity === "success" ? "bg-emerald-500" : "bg-indigo-500"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="font-semibold">{item.title}</h2><time className="text-xs text-slate-400">{new Date(item.createdAt).toLocaleString("zh-CN")}</time></div><p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p><div className="mt-4">{item.actionHref ? <button type="button" onClick={() => void open(item)} disabled={openingId !== null} className="flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{openingId === item.id ? "打开中…" : "查看详情"}</button> : <button type="button" onClick={() => void open(item)} disabled={openingId !== null} className="flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">{openingId === item.id ? "处理中…" : "知道了"}</button>}</div></div></div></article>)}</section></div></main>;
}
