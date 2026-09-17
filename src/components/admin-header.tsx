import Link from "next/link";
import Image from "next/image";
import { LogoutButton } from "@/app/logout-button";

export function AdminHeader({ username }: { username: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 text-white backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3 sm:px-8 lg:px-10">
        <Link href="/admin" className="flex min-w-0 items-center gap-3" aria-label="AI Project OS 平台管理总览">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black shadow-lg shadow-emerald-500/10">
            <Image src="/brand/ai-project-os-admin.png" alt="" width={44} height={44} priority className="h-full w-full scale-[1.75] object-cover" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold tracking-[0.12em]">AI PROJECT OS</span>
            <span className="mt-0.5 block text-[12px] font-semibold tracking-[0.16em] text-emerald-300">平台运营管理</span>
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden max-w-40 truncate text-xs font-medium text-slate-300 sm:block">{username}</span>
          <Link href="/admin/account" className="inline-flex min-h-10 items-center rounded-xl border border-white/15 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-emerald-300/50 hover:bg-white/10">管理员账户</Link>
          <LogoutButton className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-rose-500/15 hover:text-rose-200 disabled:opacity-50" />
        </div>
      </div>
    </header>
  );
}
