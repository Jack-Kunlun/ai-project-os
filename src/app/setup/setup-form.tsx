"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "初始化失败";
  } catch {
    return "初始化失败";
  }
}

export function SetupForm() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      router.replace("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "初始化失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6 py-12 text-slate-950">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-950/10 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="bg-slate-950 p-9 text-white sm:p-12">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-400 text-sm font-black text-slate-950">OS</span>
          <p className="mt-10 text-xs font-semibold uppercase tracking-[0.25em] text-indigo-300">First-run setup</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-0.04em]">先建立只有你能进入的项目记忆空间。</h1>
          <p className="mt-6 max-w-lg text-sm leading-7 text-slate-300">管理员账号用于保护项目资料、GitHub 仓库身份和模型凭据。供应商 API Key 将在页面录入并由服务端加密保存。</p>
        </section>
        <form onSubmit={submit} className="p-9 sm:p-12">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">本地管理员</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">初始化 AI Project OS</h2>
          <label className="mt-8 block text-sm font-medium" htmlFor="setup-username">用户名</label>
          <input id="setup-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          <label className="mt-5 block text-sm font-medium" htmlFor="setup-password">密码</label>
          <input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          <p className="mt-2 text-xs leading-5 text-slate-500">至少 12 位，并同时包含字母和数字。</p>
          <label className="mt-5 block text-sm font-medium" htmlFor="setup-password-confirm">再次输入密码</label>
          <input id="setup-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          {error ? <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          <button type="submit" disabled={pending} className="mt-7 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{pending ? "正在初始化…" : "创建管理员并进入"}</button>
        </form>
      </div>
    </main>
  );
}
