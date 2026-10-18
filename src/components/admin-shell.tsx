"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { modalBackdropClassName, modalSurfaceClassName } from "./modal-styles";

/** Legacy section names are kept for pages which still use AdminPageFrame. */
export type AdminSection = "overview" | "models" | "modelRoutes" | "credits" | "probes" | "sms" | "git" | "mcp" | "users" | "memberships" | "accountAccess" | "audit" | "operations" | "failures" | "guide" | "account";

type PrimarySection = "overview" | "users" | "configuration" | "security" | "operations";

const primaryItems: ReadonlyArray<{ key: PrimarySection; label: string; href: string }> = [
  { key: "overview", label: "平台总览", href: "/admin" },
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
    matches: (pathname) => pathname.startsWith("/admin/models") || pathname.startsWith("/admin/sms") || pathname === "/admin/operations/probes",
    links: [
      { label: "模型能力", href: "/admin/models", exact: true },
      { label: "短信服务", href: "/admin/sms", exact: true },
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
      { label: "资源与备份", href: "/admin/operations/backups", exact: true },
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

function NavigationLinks({ active, pathname, onNavigate }: { active: PrimarySection; pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="管理工作台导航" className="admin-primary-navigation">
      {primaryItems.map((item) => {
        const current = item.key === "overview" ? pathname === item.href : active === item.key;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={current ? (pathname === item.href ? "page" : "location") : undefined}
            onClick={onNavigate}
            className={`admin-primary-link ${current ? "is-current" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ModuleNavigation({ active, pathname }: { active: PrimarySection; pathname: string }) {
  const group = moduleGroups.find((item) => item.key === active);
  if (!group) return null;
  return (
    <nav aria-label="管理栏目" className="admin-module-navigation">
      {group.links.map((link) => {
        const current = isCurrentAdminNavigationLink(link, pathname);
        return <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined} className={`admin-module-link ${current ? "is-current" : ""}`}>{link.label}</Link>;
      })}
    </nav>
  );
}

/** Shared admin chrome: five direct destinations, with a separate section nav. */
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
    <div className="admin-workspace-shell" data-admin-workspace>
      <aside className="admin-sidebar" aria-label="管理工作台侧栏">
        <div className="admin-sidebar-brand"><span className="admin-sidebar-mark" aria-hidden="true">OS</span><span><strong>管理工作台</strong><small>AI Project OS</small></span></div>
        <NavigationLinks active={active} pathname={pathname} />
      </aside>

      <div className="admin-main-column">
        <div className="admin-mobile-toolbar">
          <span>{primaryItems.find((item) => item.key === active)?.label ?? "管理工作台"}</span>
          <button ref={triggerRef} type="button" aria-controls="admin-mobile-navigation" aria-expanded={drawerOpen} aria-haspopup="dialog" onClick={() => setDrawerOpen(true)}>打开导航</button>
        </div>
        <ModuleNavigation active={active} pathname={pathname} />
        <main className="admin-page-scroll">
          {children}
        </main>
      </div>

      {drawerOpen ? (
        <div className="admin-mobile-overlay" aria-label="管理工作台导航">
          <button type="button" tabIndex={-1} aria-label="关闭管理导航" className={`admin-mobile-backdrop ${modalBackdropClassName}`} onClick={() => setDrawerOpen(false)} />
          <div ref={drawerRef} id="admin-mobile-navigation" role="dialog" aria-modal="true" aria-labelledby="admin-mobile-navigation-title" aria-label="管理工作台导航" className={`admin-mobile-drawer ${modalSurfaceClassName}`}>
            <div className="admin-mobile-drawer-heading">
              <h2 id="admin-mobile-navigation-title">管理工作台导航</h2>
              <button ref={closeRef} type="button" aria-label="关闭管理导航" onClick={() => setDrawerOpen(false)}>关闭</button>
            </div>
            <NavigationLinks active={active} pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
            <ModuleNavigation active={active} pathname={pathname} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Compatibility frame for non-/admin pages and legacy callers. */
export function AdminPageFrame({ active, children, showSidebar = true }: { active: AdminSection; children: ReactNode; showSidebar?: boolean }) {
  if (!showSidebar) return <>{children}</>;
  const primary: PrimarySection = active === "overview" ? "overview" : active === "users" || active === "memberships" || active === "credits" || active === "accountAccess" ? "users" : active === "models" || active === "modelRoutes" || active === "probes" || active === "sms" ? "configuration" : active === "mcp" || active === "audit" ? "security" : "operations";
  return <div className="admin-legacy-frame"><NavigationLinks active={primary} pathname="/admin" /><div>{children}</div></div>;
}

/** Compatibility export for callers that only need the sidebar. */
export function AdminShell({ active }: { active: AdminSection }) {
  const primary: PrimarySection = active === "overview" ? "overview" : active === "users" || active === "memberships" || active === "credits" || active === "accountAccess" ? "users" : active === "models" || active === "modelRoutes" || active === "probes" || active === "sms" ? "configuration" : active === "mcp" || active === "audit" ? "security" : "operations";
  return <NavigationLinks active={primary} pathname="/admin" />;
}
