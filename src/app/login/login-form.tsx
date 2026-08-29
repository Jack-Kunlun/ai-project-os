"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function LoginForm({ notice, oidcProviders = [], returnTo = "/dashboard" }: { notice?: string; oidcProviders?: Array<{ id: string; name: string }>; returnTo?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "登录失败");
      }
      router.replace(returnTo);
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6 py-12 text-slate-950">
      <form onSubmit={submit} className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white p-9 shadow-xl shadow-slate-950/10 sm:p-10">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-sm font-black text-white">OS</span>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Secure workspace</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">登录 AI Project OS</h1>
        <label className="mt-8 block text-sm font-medium" htmlFor="login-username">用户名</label>
        <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required placeholder="输入登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        <label className="mt-5 block text-sm font-medium" htmlFor="login-password">密码</label>
        <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        {notice ? <p role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p> : null}
        {error ? <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
        <button type="submit" disabled={pending} className="mt-7 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{pending ? "登录中…" : "登录"}</button>
        {oidcProviders.length > 0 ? <div className="mt-7 border-t border-slate-100 pt-6"><p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">或使用企业身份</p><div className="mt-4 space-y-2">{oidcProviders.map((provider) => <a key={provider.id} href={`/api/auth/oidc/start/${provider.id}?returnTo=${encodeURIComponent(returnTo)}`} className="flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50">使用 {provider.name} 登录</a>)}</div></div> : null}
        <p className="mt-5 text-center text-xs text-slate-500"><Link href="/guide" className="font-semibold text-indigo-600 hover:text-indigo-700">打开使用指南</Link></p>
      </form>
    </main>
  );
}
