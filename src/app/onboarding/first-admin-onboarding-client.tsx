"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "首个业务 Owner 创建失败";
  } catch {
    return "首个业务 Owner 创建失败";
  }
}

export function FirstAdminOnboardingClient() {
  const router = useRouter();
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(await readError(response));
      router.replace("/admin");
      router.refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "首个业务 Owner 创建失败");
    } finally {
      setPending(false);
    }
  }

  return <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-8 lg:px-10" aria-labelledby="first-owner-title">
    <form onSubmit={complete} className="rounded-3xl border border-indigo-100 bg-indigo-50/70 p-6 shadow-sm sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Business owner bootstrap</p>
      <h2 id="first-owner-title" className="mt-2 text-xl font-semibold text-slate-950">创建首个业务 Owner</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">该账号独立登录用户工作台并管理项目。平台管理员不会加入工作区，也不会获得项目、团队或个人额度。</p>
      <div className="mt-6 grid max-w-2xl gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">Owner 用户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        </label>
        <label className="text-sm font-medium text-slate-700">初始密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        </label>
        <label className="text-sm font-medium text-slate-700">确认密码
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">至少 12 位，并同时包含字母和数字。创建后请将账号安全交付给实际业务负责人。</p>
      {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
      <button type="submit" disabled={pending} className="mt-5 inline-flex min-h-12 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-500 disabled:text-white">{pending ? "正在创建 Owner…" : "创建 Owner 并进入管理后台"}</button>
    </form>
  </section>;
}
