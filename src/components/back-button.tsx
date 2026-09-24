"use client";

import { useRouter } from "next/navigation";

/** Return to the previous page, with a stable destination for direct visits. */
export function BackButton({ fallbackHref, label = "返回上一页" }: { fallbackHref: string; label?: string }) {
  const router = useRouter();
  return <button
    type="button"
    onClick={() => { if (window.history.length > 1) router.back(); else router.push(fallbackHref); }}
    className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700"
  ><span aria-hidden="true">←</span>{label}</button>;
}
