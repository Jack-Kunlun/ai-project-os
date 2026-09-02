import Link from "next/link";
import type { ReactNode } from "react";
import { APP_VERSION } from "@/lib/version";

export function PublicInfoPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-[radial-gradient(circle_at_10%_5%,rgba(224,231,255,.72),transparent_26%),radial-gradient(circle_at_90%_95%,rgba(237,233,254,.68),transparent_28%),#f7f9fd] px-5 py-8 text-slate-950 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/login" className="flex items-center gap-3" aria-label="返回 AI Project OS 登录页">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-xs font-bold text-white shadow-lg">OS</span>
            <span>
              <span className="block text-sm font-bold tracking-[0.14em]">AI PROJECT OS</span>
              <span className="mt-0.5 block text-[10px] uppercase tracking-[0.14em] text-slate-500">内部开发版 · {APP_VERSION}</span>
            </span>
          </Link>
          <Link href="/login" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700">返回登录</Link>
        </header>

        <section className="mt-8 overflow-hidden rounded-[2rem] border border-white/90 bg-white shadow-[0_20px_58px_rgba(15,23,42,.10)] sm:mt-10">
          <div className="bg-slate-950 px-7 py-9 text-white sm:px-10 sm:py-11">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">{eyebrow}</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{title}</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">{description}</p>
          </div>
          <div className="space-y-8 px-7 py-8 text-sm leading-7 text-slate-600 sm:px-10 sm:py-10">{children}</div>
        </section>

        <nav aria-label="公开信息" className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
          <Link href="/privacy" className="hover:text-indigo-600">隐私政策</Link>
          <Link href="/terms" className="hover:text-indigo-600">服务条款</Link>
          <Link href="/help" className="hover:text-indigo-600">帮助文档</Link>
        </nav>
      </div>
    </main>
  );
}

export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h2 className="text-lg font-semibold text-slate-900">{title}</h2><div className="mt-3 space-y-3">{children}</div></section>;
}
