"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AcceptInvitationClient({ token }: { token: string }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  async function accept() { setPending(true); setError(null); try { const response = await fetch("/api/workspace-invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, returnTo: "/dashboard" }) }); if (!response.ok) { const payload = await response.json() as { error?: { message?: string } }; throw new Error(payload.error?.message ?? "邀请接受失败"); } router.replace("/dashboard"); router.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "邀请接受失败"); setPending(false); } }
  return <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6"><section className="w-full max-w-lg rounded-[2rem] border border-slate-200 bg-white p-9 text-center shadow-xl"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-600 font-bold text-white">OS</span><h1 className="mt-6 text-3xl font-semibold">加入工作区</h1><p className="mt-3 text-sm leading-6 text-slate-500">确认后，系统会按邀请中指定的工作区与项目角色授权当前账户。邀请令牌只会使用一次。</p>{error ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}<button onClick={() => void accept()} disabled={pending} className="mt-7 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "正在加入…" : "接受邀请"}</button></section></main>;
}
