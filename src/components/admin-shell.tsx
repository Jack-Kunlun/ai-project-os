"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { adminNavigationGroups, getAdminNavigationState } from "@/lib/admin-navigation";
import { useTranslate } from "./appearance-provider";
import { BrandMark } from "./brand-mark";
import { AdminHeader } from "./admin-header";
import { ShellIcon, type ShellIconName } from "./shell-icon";
const WorkspaceDialog = lazy(() => import("./workspace-dialog").then(module => ({ default: module.WorkspaceDialog })));

export { getAdminNavigationState } from "@/lib/admin-navigation";
/** Legacy section names remain compatible with the guarded redirect pages. */
export type AdminSection = "overview" | "models" | "modelRoutes" | "credits" | "probes" | "sms" | "git" | "mcp" | "users" | "memberships" | "accountAccess" | "audit" | "operations" | "failures" | "guide" | "account";

const navigationIcons: Record<string, ShellIconName> = {
  "/admin": "dashboard",
  "/admin/users": "team",
  "/admin/users/memberships": "shield",
  "/admin/credits": "credits",
  "/admin/models": "server",
  "/admin/connectors/mcp": "shield",
  "/admin/sms": "message",
  "/admin/audit": "file",
  "/admin/operations/backups": "archive",
  "/admin/operations/failures": "alert",
  "/admin/operations/probes": "chart",
  "/admin/account": "person",
  "/admin/guide": "book",
};

function NavigationLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const t = useTranslate();
  const { currentLinks } = getAdminNavigationState(pathname);
  return <nav aria-label={t("管理工作台导航")} className="admin-primary-navigation">
    {adminNavigationGroups.map(group => <section key={group.key} className="admin-navigation-group">
      <h2>{t(group.label)}</h2>
      {group.links.map(item => <Link key={item.href} href={item.href} aria-current={currentLinks.includes(item.href) ? "page" : undefined} onClick={onNavigate} className={`admin-primary-link ${currentLinks.includes(item.href) ? "is-current" : ""}`}>
        <ShellIcon name={navigationIcons[item.href] ?? "grid"} className="app-icon--control" />
        <span>{t(item.label)}</span>
      </Link>)}
    </section>)}
  </nav>;
}

/** Direct grouped destinations mirror the accepted admin prototype. */
export function AdminAppShell({ children, username }: { children: ReactNode; username: string }) {
  const pathname = usePathname();
  const t = useTranslate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  return <div className="admin-workspace-shell">
    <aside className="admin-sidebar" aria-label={t("管理工作台侧栏")}>
      <Link href="/admin" className="admin-sidebar-brand" aria-label={t("AI Project OS 平台管理总览")}><BrandMark size={30} priority /><strong>AI Project OS</strong></Link>
      <div className="admin-workspace-context"><span aria-hidden="true">{t("管")}</span><strong>{t("管理工作空间")}</strong></div>
      <NavigationLinks pathname={pathname} />
    </aside>
    <div className="admin-main-column">
      <AdminHeader username={username} drawerOpen={drawerOpen} onOpenNavigation={() => setDrawerOpen(true)} />
      <main className="admin-page-scroll">{children}</main>
    </div>
    <Suspense fallback={null}>{drawerOpen ? <WorkspaceDialog title="管理工作台导航" open={drawerOpen} onClose={() => setDrawerOpen(false)} drawer>
      <NavigationLinks pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
    </WorkspaceDialog> : null}</Suspense>
  </div>;
}

/** Compatibility for old entry points, which retain their existing redirects. */
export function AdminPageFrame({ children, showSidebar = true }: { active: AdminSection; children: ReactNode; showSidebar?: boolean }) {
  const pathname = usePathname();
  if (!showSidebar) return <>{children}</>;
  return <div className="admin-legacy-frame"><NavigationLinks pathname={pathname} /><div>{children}</div></div>;
}

export function AdminShell({ active }: { active: AdminSection }) {
  return <NavigationLinks key={active} pathname={usePathname()} />;
}
