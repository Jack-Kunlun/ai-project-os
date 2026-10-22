"use client";

import Link from "next/link";
import { ShellIcon } from "./shell-icon";
import { useTranslate } from "./appearance-provider";
import { useCallback, useEffect, useState } from "react";

export function NotificationBell({ active,compact=false }: { active: boolean;compact?:boolean }) {
  const t=useTranslate();
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
    const onNotificationsChanged = () => void reload();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("ai-project-os:notifications-changed", onNotificationsChanged);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("ai-project-os:notifications-changed", onNotificationsChanged);
    };
  }, [reload]);

  return <Link href="/notifications" aria-label={unreadCount>0?`${t("通知中心")} · ${unreadCount}`:t("通知中心")} aria-current={active ? "page" : undefined} title={t("通知中心")} className={`app-icon-only relative flex ${compact?"h-8 w-8 border-0":"h-11 w-11"} items-center justify-center rounded-full border transition ${active ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"}`}><ShellIcon name="bell" className="app-icon--control" />{unreadCount > 0 ? <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}</Link>;
}
