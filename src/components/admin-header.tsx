import Link from "next/link";
import { LogoutButton } from "@/app/logout-button";
import { BrandMark } from "@/components/brand-mark";

export function AdminHeader({ username }: { username: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 text-white backdrop-blur-xl">
      <div className="flex w-full items-center justify-between gap-4 px-4 py-3 sm:px-5 lg:px-6">
        <Link href="/admin" className="flex min-w-0 items-center gap-3" aria-label="AI Project OS 平台管理总览">
          <BrandMark size={44} priority />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold tracking-[0.12em]">AI PROJECT OS</span>
            <span className="mt-0.5 block text-[12px] font-semibold tracking-[0.16em] text-emerald-300">平台运营管理</span>
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/admin/guide" className="hidden min-h-10 items-center rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-emerald-300/50 hover:bg-white/10 sm:inline-flex">管理员指南</Link>
          <Link href="/admin/account" aria-label={`管理员账户：${username}`} className="inline-flex min-h-10 max-w-40 items-center truncate rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-emerald-300/50 hover:bg-white/10">{username}</Link>
          <LogoutButton className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-rose-500/15 hover:text-rose-200 disabled:opacity-50" />
        </div>
      </div>
    </header>
  );
}
