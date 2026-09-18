"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Legacy section names are kept for pages which still use AdminPageFrame
 * outside the /admin layout. The shared /admin layout renders the five
 * product-level sections below.
 */
export type AdminSection = "overview" | "models" | "modelRoutes" | "credits" | "probes" | "git" | "mcp" | "users" | "memberships" | "accountAccess" | "audit" | "operations" | "failures" | "guide" | "account";

type PrimarySection = "overview" | "users" | "configuration" | "security" | "operations";

const primaryItems: ReadonlyArray<{ key: PrimarySection; label: string; href: string }> = [
  { key: "overview", label: "Dashboard", href: "/admin" },
  { key: "users", label: "用户与权益", href: "/admin/users" },
  { key: "configuration", label: "配置中心", href: "/admin/models" },
  { key: "security", label: "安全中心", href: "/admin/connectors/mcp" },
  { key: "operations", label: "运维中心", href: "/admin/operations/failures" },
];

const isAdminUserPath = (pathname: string): boolean => pathname === "/admin/users" || (pathname.startsWith("/admin/users/") && pathname !== "/admin/users/memberships");

const moduleGroups: ReadonlyArray<Readonly<{
  key: Exclude<PrimarySection, "overview">;
  label: string;
  matches: (pathname: string) => boolean;
  links: ReadonlyArray<{ label: string; href: string; exact?: boolean; matches?: (pathname: string) => boolean }>;
}>> = [
  {
    key: "users",
    label: "用户与权益",
    matches: (pathname) => pathname.startsWith("/admin/users") || pathname === "/admin/credits",
    links: [
      { label: "用户", href: "/admin/users", matches: isAdminUserPath },
      { label: "会员", href: "/admin/users/memberships", exact: true },
      { label: "额度", href: "/admin/credits", exact: true },
    ],
  },
  {
    key: "configuration",
    label: "配置中心",
    matches: (pathname) => pathname.startsWith("/admin/models") || pathname === "/admin/operations/probes",
    links: [
      { label: "能力配置", href: "/admin/models", exact: true },
      { label: "探测预算", href: "/admin/operations/probes", exact: true },
    ],
  },
  {
    key: "security",
    label: "安全中心",
    matches: (pathname) => pathname.startsWith("/admin/connectors/mcp") || pathname.startsWith("/admin/audit"),
    links: [
      { label: "MCP 审核", href: "/admin/connectors/mcp", exact: true },
      { label: "审计记录", href: "/admin/audit", exact: true },
    ],
  },
  {
    key: "operations",
    label: "运维中心",
    matches: (pathname) => pathname.startsWith("/admin/operations"),
    links: [
      { label: "失败收件箱", href: "/admin/operations/failures", exact: true },
      { label: "备份状态", href: "/admin/operations/backups", exact: true },
    ],
  },
];

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function primarySectionForPath(pathname: string): PrimarySection {
  if (pathname === "/admin") return "overview";
  return moduleGroups.find((item) => item.matches(pathname))?.key ?? "overview";
}

function isCurrentAdminNavigationLink(link: { href: string; exact?: boolean; matches?: (pathname: string) => boolean }, pathname: string): boolean {
  return link.matches ? link.matches(pathname) : link.exact ? pathname === link.href : pathname.startsWith(link.href);
}

export function getAdminNavigationState(pathname: string): { active: PrimarySection; currentLinks: string[] } {
  const active = primarySectionForPath(pathname);
  const group = moduleGroups.find((item) => item.key === active);
  return {
    active,
    currentLinks: group?.links.filter((link) => isCurrentAdminNavigationLink(link, pathname)).map((link) => link.href) ?? [],
  };
}

function NavigationLinks({ active, pathname, onNavigate }: { active: PrimarySection; pathname?: string; onNavigate?: () => void }) {
  const currentPath = pathname ?? "";
  const [expanded, setExpanded] = useState<Record<PrimarySection, boolean>>(() => ({
    overview: active === "overview",
    users: active === "users",
    configuration: active === "configuration",
    security: active === "security",
    operations: active === "operations",
  }));

  return (
    <nav aria-label="管理工作台导航" className="grid gap-1">
      {primaryItems.map((item) => {
        const group = moduleGroups.find((candidate) => candidate.key === item.key);
        const isActive = item.key === active;
        const isExpanded = item.key !== "overview" && expanded[item.key];
        return (
          <div key={item.key}>
            {group ? (
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`admin-nav-${item.key}`}
                aria-label={`${isExpanded ? "收起" : "展开"}${item.label}`}
                onClick={() => setExpanded((current) => ({ ...current, [item.key]: !current[item.key] }))}
                className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${isActive ? "border border-indigo-100 bg-indigo-50/75 text-indigo-800" : "text-slate-600 hover:bg-slate-50 hover:text-indigo-700"}`}
              >
                <span>{item.label}</span>
                <ChevronIcon expanded={isExpanded} />
              </button>
            ) : (
              <Link
                href={item.href}
                aria-current={currentPath === item.href ? "page" : undefined}
                onClick={onNavigate}
                className={`flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${isActive ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-50 hover:text-indigo-700"}`}
              >
                {item.label}
              </Link>
            )}
            {group && isExpanded ? (
              <div id={`admin-nav-${item.key}`} className="ml-3 mt-1 grid gap-1 border-l border-slate-200 pl-3">
                {group.links.map((link) => {
                  const current = isCurrentAdminNavigationLink(link, currentPath);
                  return <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined} onClick={onNavigate} className={`flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${current ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-50 hover:text-indigo-700"}`}>{link.label}</Link>;
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return <svg aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m5.5 7.5 4.5 4.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Shared fixed-header, fixed-sidebar admin chrome used by every /admin page. */
export function AdminAppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = primarySectionForPath(pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalBodyOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !drawerRef.current?.contains(target)) closeRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      document.body.style.overflow = originalBodyOverflow;
      previousFocus?.focus();
    };
  }, [drawerOpen]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-3 py-5 lg:block" aria-label="管理工作台侧栏">
        <div className="mb-5 border-b border-slate-100 px-3 pb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">管理工作台</h2>
        </div>
        <NavigationLinks key={active} active={active} pathname={pathname} />
      </aside>

      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
          <span className="text-sm font-semibold text-slate-800">{primaryItems.find((item) => item.key === active)?.label}</span>
          <button ref={triggerRef} type="button" aria-controls="admin-mobile-navigation" aria-expanded={drawerOpen} aria-haspopup="dialog" onClick={() => setDrawerOpen(true)} className="min-h-10 shrink-0 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">打开导航</button>
        </div>
        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </main>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" aria-label="移动端管理导航">
          <button type="button" tabIndex={-1} aria-label="关闭管理导航" className="absolute inset-0 bg-slate-950/40" onClick={() => setDrawerOpen(false)} />
          <div ref={drawerRef} id="admin-mobile-navigation" role="dialog" aria-modal="true" aria-labelledby="admin-mobile-navigation-title" className="absolute right-0 top-0 h-full w-full max-w-sm overflow-y-auto bg-white p-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-2 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
                <h2 id="admin-mobile-navigation-title" className="mt-1 text-lg font-semibold text-slate-950">管理工作台导航</h2>
              </div>
              <button ref={closeRef} type="button" aria-label="关闭管理导航" onClick={() => setDrawerOpen(false)} className="min-h-10 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">关闭</button>
            </div>
            <div className="mt-4"><NavigationLinks key={active} active={active} pathname={pathname} onNavigate={() => setDrawerOpen(false)} /></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Compatibility frame for non-/admin pages and legacy callers. */
export function AdminPageFrame({ active, children, showSidebar = true }: { active: AdminSection; children: ReactNode; showSidebar?: boolean }) {
  if (!showSidebar) return <>{children}</>;
  const primary: PrimarySection = active === "overview" ? "overview" : active === "users" || active === "memberships" || active === "credits" || active === "accountAccess" ? "users" : active === "models" || active === "modelRoutes" || active === "probes" ? "configuration" : active === "mcp" || active === "audit" ? "security" : "operations";
  return <div className="w-full px-4 pb-12 pt-4 sm:px-5 lg:px-6"><div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-5"><aside className="sticky top-4 hidden rounded-2xl border border-indigo-100 bg-white/95 p-3 shadow-sm backdrop-blur lg:block"><NavigationLinks key={primary} active={primary} /></aside><div className="min-w-0">{children}</div></div></div>;
}

/** Compatibility export for callers that only need the sidebar. */
export function AdminShell({ active }: { active: AdminSection }) {
  const primary: PrimarySection = active === "overview" ? "overview" : active === "users" || active === "memberships" || active === "credits" || active === "accountAccess" ? "users" : active === "models" || active === "modelRoutes" || active === "probes" ? "configuration" : active === "mcp" || active === "audit" ? "security" : "operations";
  return <NavigationLinks key={primary} active={primary} />;
}
