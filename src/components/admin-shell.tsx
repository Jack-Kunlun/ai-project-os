"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type AdminSection = "overview" | "models" | "git" | "mcp" | "memberships" | "accountAccess" | "operations" | "guide";

const items: Array<{ key: AdminSection; label: string; href: string; description: string }> = [
  { key: "overview", label: "总览", href: "/admin", description: "平台就绪与待处理" },
  { key: "models", label: "平台模型", href: "/admin/models", description: "托管模型与默认路由" },
  { key: "git", label: "Git 连接", href: "/admin/connectors/git", description: "用户私有连接边界" },
  { key: "mcp", label: "MCP 连接", href: "/admin/connectors/mcp", description: "安全认证与只读工具" },
  { key: "memberships", label: "用户与会员", href: "/admin/users/memberships", description: "会员资格管理" },
  { key: "accountAccess", label: "账号状态", href: "/system/account-access", description: "停用与恢复治理" },
  { key: "operations", label: "备份 / 运维", href: "/admin/operations/backups", description: "受限只读状态" },
  { key: "guide", label: "管理员指南", href: "/admin/guide", description: "职责与安全边界" },
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
    <section className="mx-auto max-w-7xl px-4 pt-4 sm:px-8 lg:px-10">
      <div className="rounded-3xl border border-indigo-100 bg-white/95 p-3 shadow-lg shadow-slate-950/5 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-3 pb-3">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-indigo-600">Admin workspace</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">管理工作台</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-4 text-slate-500">平台托管模型与安全状态 · 用户 Git / MCP 连接仍归个人配置</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/dashboard" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">返回用户工作台</Link>
            <button
              ref={triggerRef}
              type="button"
              aria-controls="admin-mobile-navigation"
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              onClick={() => setDrawerOpen(true)}
              className="min-h-10 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 lg:hidden"
            >
              打开导航
            </button>
          </div>
        </div>
        <nav aria-label="管理工作台导航" className="mt-3 hidden gap-1 overflow-x-auto pb-1 lg:flex">
          <NavigationLinks active={active} />
        </nav>
        <p className="mt-2 px-3 text-[12px] leading-4 text-slate-400 lg:block">管理员只治理平台策略与安全证据，不代持个人凭据；真实外部调用需单独现场验收。</p>
      </div>
    </section>

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
        <p className="mt-5 rounded-2xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">Git 与 MCP 是每个用户自己的连接。这里仅显示平台级治理入口与安全认证状态，不会读取个人 Token。</p>
      </div>
    </div> : null}
  </>;
}
