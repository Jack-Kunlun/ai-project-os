"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { adminNavigationItems, getAdminNavigationState } from "@/lib/admin-navigation";
import { useTranslate } from "./appearance-provider";
import { AppearanceControls } from "./appearance-controls";
import { HeaderAccount } from "./header-account";
import { ShellIcon } from "./shell-icon";
const WorkspaceDialog = lazy(() => import("./workspace-dialog").then(module => ({ default: module.WorkspaceDialog })));

export function AdminHeader({ username, onOpenNavigation, drawerOpen = false }: { username: string; onOpenNavigation?: () => void; drawerOpen?: boolean }) {
  const t = useTranslate();
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = adminNavigationItems.find(item => getAdminNavigationState(pathname).currentLinks.includes(item.href));
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      const modalOpen = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')]
        .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      if (!drawerOpen && !modalOpen) setSearchOpen(true);
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [drawerOpen]);
  const matches = adminNavigationItems.filter(item => `${item.label} ${t(item.label)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <>
    <header className="admin-global-header">
      <div className="admin-breadcrumbs">
        {onOpenNavigation ? <button className="admin-mobile-toggle admin-icon-button" type="button" aria-label={t("打开导航")} aria-expanded={drawerOpen} aria-haspopup="dialog" aria-disabled={searchOpen} onClick={() => { if (!searchOpen) onOpenNavigation(); }}><ShellIcon name="menu" className="app-icon--control" /></button> : null}
        <Link href="/admin">{t("平台管理")}</Link><span aria-hidden="true">›</span><span className="admin-current-crumb">{t(current?.label ?? "平台总览")}</span>
      </div>
      <div className="admin-header-actions">
        <button type="button" className="admin-search-trigger admin-icon-button" aria-label={t("搜索功能页面")} disabled={drawerOpen} onClick={() => { setSearch(""); setSearchOpen(true); }}><ShellIcon name="search" className="app-icon--control" /><span>{t("搜索与跳转")}</span><kbd>⌘ K</kbd></button>
        <Link className="admin-icon-button" href="/admin/operations/failures" aria-label={t("通知与任务")} title={t("通知与任务")}><ShellIcon name="bell" className="app-icon--control" /></Link>
        <Link className="admin-icon-button" href="/admin/guide" aria-label={t("帮助")} title={t("帮助")}><ShellIcon name="help" className="app-icon--control" /></Link>
        <AppearanceControls />
        <HeaderAccount username={username} accountHref="/admin/account" />
      </div>
    </header>
    <Suspense fallback={null}>{searchOpen ? <WorkspaceDialog title="搜索功能页面" open={searchOpen} onClose={() => setSearchOpen(false)}>
      <div className="admin-navigation-search"><label><span>{t("搜索功能页面")}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("输入功能名称，例如用户、模型或备份")} /></label>
        <nav aria-label={t("功能搜索结果")}>{matches.length ? matches.map(item => <Link href={item.href} key={item.href} onClick={() => setSearchOpen(false)}><span>{t(item.label)}</span><span aria-hidden="true">↗</span></Link>) : <p role="status">{t("没有匹配的功能页面")}</p>}</nav>
      </div>
    </WorkspaceDialog> : null}</Suspense>
  </>;
}
