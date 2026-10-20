import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { UiText } from "@/components/appearance-provider";

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
          <Link href="/login" className="flex items-center gap-3" aria-labelledby="public-info-login-label">
            <BrandMark size={40} />
            <span>
              <span className="block text-sm font-bold tracking-[0.14em]">AI PROJECT OS</span>
            </span>
            <span id="public-info-login-label" className="sr-only"><UiText text="返回 AI Project OS 登录页" /></span>
          </Link>
          <Link href="/login" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"><UiText text="返回登录" /></Link>
        </header>

        <section className="mt-8 overflow-hidden rounded-[2rem] border border-white/90 bg-white shadow-[0_20px_58px_rgba(15,23,42,.10)] sm:mt-10">
          <div className="bg-slate-950 px-7 py-9 text-white sm:px-10 sm:py-11">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300"><UiText text={eyebrow} /></p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl"><UiText text={title} /></h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300"><UiText text={description} /></p>
          </div>
          <div className="space-y-8 px-7 py-8 text-sm leading-7 text-slate-600 sm:px-10 sm:py-10">{children}</div>
        </section>

        <nav aria-labelledby="public-info-nav-label" className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
          <span id="public-info-nav-label" className="sr-only"><UiText text="公开信息" /></span>
          <Link href="/privacy" className="hover:text-indigo-600"><UiText text="隐私政策" /></Link>
          <Link href="/terms" className="hover:text-indigo-600"><UiText text="服务条款" /></Link>
          <Link href="/help" className="hover:text-indigo-600"><UiText text="帮助文档" /></Link>
          <Link href="/contact" className="hover:text-indigo-600"><UiText text="联系作者" /></Link>
        </nav>
      </div>
    </main>
  );
}

export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h2 className="text-lg font-semibold text-slate-900"><UiText text={title} /></h2><div className="mt-3 space-y-3">{children}</div></section>;
}
