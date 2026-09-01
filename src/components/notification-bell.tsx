"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export function NotificationBell({ active }: { active: boolean }) {
  const [unreadCount, setUnreadCount] = useState(0);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { unreadCount?: number };
      setUnreadCount(Number.isSafeInteger(payload.unreadCount) ? Math.max(0, payload.unreadCount ?? 0) : 0);
    } catch {
      // Navigation remains available when the count cannot be refreshed.
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void reload(), 0);
    const interval = window.setInterval(() => void reload(), 30_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);

  const label = unreadCount > 0 ? `打开通知中心，${unreadCount} 条未读` : "打开通知中心";
  return <Link href="/notifications" aria-label={label} aria-current={active ? "page" : undefined} title={label} className={`relative flex h-11 w-11 items-center justify-center rounded-full border transition ${active ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"}`}><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>{unreadCount > 0 ? <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}</Link>;
}
