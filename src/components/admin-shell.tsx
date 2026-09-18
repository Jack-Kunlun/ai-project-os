"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type AdminSection = "overview" | "models" | "modelRoutes" | "credits" | "probes" | "git" | "mcp" | "users" | "memberships" | "accountAccess" | "audit" | "operations" | "failures" | "guide" | "account";

const items: Array<{ key: AdminSection; label: string; href: string; description: string }> = [
  { key: "overview", label: "总览", href: "/admin", description: "平台就绪与待处理" },
  { key: "models", label: "平台模型", href: "/admin/models", description: "供应商与模型连接" },
  { key: "modelRoutes", label: "默认路由", href: "/admin/models/routes", description: "能力路由与倍率" },
  { key: "credits", label: "平台额度", href: "/admin/credits", description: "赠送策略与额度治理" },
  { key: "probes", label: "探测预算", href: "/admin/operations/probes", description: "连接测试预算" },
  { key: "mcp", label: "MCP 安全", href: "/admin/connectors/mcp", description: "工具认证与平台安全" },
  { key: "users", label: "用户运营", href: "/admin/users", description: "账号、会员与额度" },
  { key: "audit", label: "审计中心", href: "/admin/audit", description: "安全证据与变更历史" },
  { key: "failures", label: "失败收件箱", href: "/admin/operations/failures", description: "失败与待对账" },
  { key: "operations", label: "备份 / 运维", href: "/admin/operations/backups", description: "受限只读状态" },
  { key: "guide", label: "管理员指南", href: "/admin/guide", description: "职责与安全边界" },
  { key: "account", label: "管理员账户", href: "/admin/account", description: "登录资料与安全" },
];

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function NavigationLinks({ active, onNavigate }: { active: AdminSection; onNavigate?: () => void }) {
  return <>
    {items.map((item) => (
      <Link
        key={item.key}
        href={item.href}
        aria-current={item.key === active ? "page" : undefined}
        onClick={onNavigate}
        className={`group rounded-xl px-3 py-2.5 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${item.key === active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"}`}
      >
        <span className="block text-xs font-semibold">{item.label}</span>
        <span className={`mt-1 block text-[12px] leading-4 ${item.key === active ? "text-slate-300" : "text-slate-400 group-hover:text-indigo-500"}`}>{item.description}</span>
      </Link>
    ))}
  </>;
}

export function AdminPageFrame({ active, children, showSidebar = true }: { active: AdminSection; children: ReactNode; showSidebar?: boolean }) {
  if (!showSidebar) return <>{children}</>;
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-4 sm:px-8 lg:px-10">
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <AdminShell active={active} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

export function AdminShell({ active }: { active: AdminSection }) {
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
      if (!(target instanceof Node) || !drawerRef.current?.contains(target)) {
        closeRef.current?.focus();
      }
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

  return <>
    <section className="rounded-3xl border border-indigo-100 bg-white/95 p-3 shadow-lg shadow-slate-950/5 backdrop-blur lg:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">管理工作台</h2>
        </div>
        <button
          ref={triggerRef}
          type="button"
          aria-controls="admin-mobile-navigation"
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          onClick={() => setDrawerOpen(true)}
          className="min-h-10 shrink-0 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        >
          打开导航
        </button>
      </div>
      <p className="mt-2 px-1 text-[12px] leading-4 text-slate-400">管理员只治理平台策略与安全证据，不代持个人凭据。</p>
    </section>

    <aside className="sticky top-24 hidden rounded-3xl border border-indigo-100 bg-white/95 p-3 shadow-lg shadow-slate-950/5 backdrop-blur lg:flex lg:flex-col">
      <div className="border-b border-slate-100 px-3 pb-3">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">管理工作台</h2>
            <p className="mt-1 text-[12px] leading-4 text-slate-500">平台配置、用户治理、安全审计与运维状态</p>
          </div>
        </div>
        <nav aria-label="管理工作台导航" className="mt-3 grid gap-1">
          <NavigationLinks active={active} />
        </nav>
        <p className="mt-3 px-3 text-[12px] leading-4 text-slate-400">平台管理员不进入项目、团队和用户工作区，也不代持用户个人凭据。</p>
    </aside>

    {drawerOpen ? <div className="fixed inset-0 z-50 lg:hidden" aria-label="移动端管理导航">
      <button type="button" tabIndex={-1} aria-label="关闭管理导航" className="absolute inset-0 bg-slate-950/40" onClick={() => setDrawerOpen(false)} />
      <div ref={drawerRef} id="admin-mobile-navigation" role="dialog" aria-modal="true" aria-labelledby="admin-mobile-navigation-title" className="absolute right-0 top-0 h-full w-full max-w-sm overflow-y-auto bg-white p-4 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-2 pb-4">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
            <h2 id="admin-mobile-navigation-title" className="mt-1 text-lg font-semibold text-slate-950">管理工作台导航</h2>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭管理导航" onClick={() => setDrawerOpen(false)} className="min-h-10 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">关闭</button>
        </div>
        <nav aria-label="移动端管理工作台导航" className="mt-4 grid gap-2">
          <NavigationLinks active={active} onNavigate={() => setDrawerOpen(false)} />
        </nav>
        <p className="mt-5 rounded-2xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">这里仅提供平台运营与安全治理能力，不展示用户项目、团队或个人连接。</p>
      </div>
    </div> : null}
  </>;
}
