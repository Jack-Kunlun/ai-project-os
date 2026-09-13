"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "首次管理员引导暂时无法完成";
  } catch {
    return "首次管理员引导暂时无法完成";
  }
}

export function FirstAdminOnboardingClient() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(await readError(response));
      router.replace("/dashboard");
      router.refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "首次管理员引导暂时无法完成");
    } finally {
      setPending(false);
    }
  }

  return <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-8 lg:px-10" aria-labelledby="first-admin-onboarding-action-title">
    <div className="rounded-3xl border border-indigo-100 bg-indigo-50/70 p-6 shadow-sm sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Explicit acknowledgement</p>
      <h2 id="first-admin-onboarding-action-title" className="mt-2 text-xl font-semibold text-slate-950">确认已查看首次就绪清单</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">清单不要求全部变绿。完成引导只记录你已查看管理工作台，不等于模型、Git、MCP 或其他外部服务已经现场验证。</p>
      {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
      <button type="button" onClick={() => void complete()} disabled={pending} className="mt-5 inline-flex min-h-12 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-500 disabled:text-white">{pending ? "正在保存确认…" : "我已查看，进入日常工作区"}</button>
    </div>
  </section>;
}
