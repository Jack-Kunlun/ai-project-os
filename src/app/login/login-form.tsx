"use client";

import { useState, type FormEvent } from "react";
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
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_#e0e7ff,_transparent_38%),#f5f7fb] px-5 py-8 text-slate-950 sm:px-8 sm:py-12">
      <div className="grid w-full max-w-6xl overflow-hidden rounded-[2rem] border border-slate-200/80 bg-white shadow-2xl shadow-slate-950/10 lg:grid-cols-[1.08fr_.92fr]">
        <section className="relative overflow-hidden bg-slate-950 px-7 py-10 text-white sm:px-10 sm:py-12 lg:px-14 lg:py-14">
          <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-indigo-500/30 blur-3xl" />
          <div className="absolute -bottom-28 -left-20 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
          <div className="relative">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-sm font-black text-slate-950 shadow-lg">OS</span>
            <p className="mt-10 text-xs font-semibold uppercase tracking-[0.24em] text-indigo-300">AI Project OS</p>
            <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-5xl">让项目知识可追溯，让每一次行动都有边界。</h1>
            <p className="mt-6 max-w-xl text-sm leading-7 text-slate-300">把项目资料、代码来源、当前状态和团队协作放在同一个受控空间中。系统保留原始证据与引用链，帮助团队从可靠资料出发理解项目。</p>
            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              <Feature title="资料有出处">来源、文件与代码快照保留内容指纹和定位信息。</Feature>
              <Feature title="权限有边界">工作区与项目角色由服务端统一校验。</Feature>
              <Feature title="确认在人手">AI 只生成候选；事实、状态和资料发布由人审核。</Feature>
              <Feature title="动作受控制">外部只读能力逐项授权、逐次审批并留下审计。</Feature>
            </div>
            <p className="mt-10 max-w-xl text-xs leading-6 text-slate-400">当前产品聚焦可追溯资料、人工确认、项目记忆和受控只读能力；不会替你修改代码、写入 Git、执行 Shell 或部署。</p>
          </div>
        </section>

        <form onSubmit={submit} className="px-7 py-10 sm:px-10 sm:py-12 lg:px-12 lg:py-14">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Secure workspace</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">登录 AI Project OS</h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">使用账户登录你的工作区，继续处理项目资料与治理任务。</p>
          <label className="mt-8 block text-sm font-medium" htmlFor="login-username">用户名</label>
          <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required placeholder="输入登录名" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          <label className="mt-5 block text-sm font-medium" htmlFor="login-password">密码</label>
          <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          {notice ? <p role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p> : null}
          {error ? <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          <button type="submit" disabled={pending} className="mt-7 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{pending ? "登录中…" : "登录"}</button>
          {oidcProviders.length > 0 ? <div className="mt-7 border-t border-slate-100 pt-6"><p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">或使用企业身份</p><div className="mt-4 space-y-2">{oidcProviders.map((provider) => <a key={provider.id} href={`/api/auth/oidc/start/${provider.id}?returnTo=${encodeURIComponent(returnTo)}`} className="flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50">使用 {provider.name} 登录</a>)}</div></div> : null}
        </form>
      </div>
    </main>
  );
}

function Feature({ title, children }: { title: string; children: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-sm font-semibold text-white">{title}</p><p className="mt-2 text-xs leading-5 text-slate-400">{children}</p></div>;
}
