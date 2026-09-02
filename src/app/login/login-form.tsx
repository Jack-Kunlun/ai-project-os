"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type LoginFormProps = {
  notice?: string;
  noticeTone?: "success" | "error";
  oidcProviders?: Array<{ id: string; name: string }>;
  returnTo?: string;
  githubLoginAvailable?: boolean;
};

export function LoginForm({
  notice,
  noticeTone = "success",
  oidcProviders = [],
  returnTo = "/dashboard",
  githubLoginAvailable = false,
}: LoginFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
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

  const githubHref = `/api/auth/github/start?intent=login&remember=${remember ? "true" : "false"}&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="flex min-h-screen flex-col justify-center overflow-x-hidden bg-[radial-gradient(circle_at_8%_5%,rgba(224,231,255,.72),transparent_24%),radial-gradient(circle_at_92%_94%,rgba(237,233,254,.68),transparent_25%),#f7f9fd] px-4 py-4 text-slate-950 sm:px-6 sm:py-5">
      <div className="mx-auto grid w-full max-w-[1280px] overflow-hidden rounded-[30px] border border-white/90 bg-white shadow-[0_20px_58px_rgba(15,23,42,.12)] lg:min-h-[min(720px,calc(100dvh-70px))] lg:grid-cols-2">
        <section className="relative order-2 overflow-hidden bg-[radial-gradient(circle_at_91%_0%,rgba(91,33,182,.56),transparent_34%),linear-gradient(145deg,#060b19_0%,#070d1d_60%,#11102c_100%)] px-7 py-7 text-white sm:px-9 sm:py-8 lg:order-1 lg:px-10 lg:py-8 lg:pl-11">
          <div className="pointer-events-none absolute -bottom-40 right-[-72px] h-80 w-80 rounded-full border border-violet-400/10" />
          <div className="pointer-events-none absolute -bottom-28 right-[-28px] h-60 w-60 rounded-full border border-indigo-400/10" />
          <div className="pointer-events-none absolute bottom-[116px] right-10 h-1.5 w-1.5 rounded-full bg-indigo-300/70 shadow-[0_0_18px_5px_rgba(129,140,248,.35)]" />
          <div className="relative flex min-h-full flex-col">
            <div className="flex items-center gap-4">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-white text-sm font-black tracking-tight text-slate-950 shadow-lg">OS</span>
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-slate-100">AI Project OS</span>
            </div>

            <div className="mt-8">
              <p className="text-[11px] font-bold uppercase tracking-[0.27em] text-indigo-400">AI Project OS</p>
              <h1 className="mt-3 max-w-[560px] text-[34px] font-semibold leading-[1.17] tracking-[-0.045em] sm:text-[38px] lg:text-[36px] xl:text-[42px]">让项目知识可追溯，<br />让每一次行动都有边界。</h1>
              <p className="mt-4 max-w-[560px] text-[13px] leading-6 text-slate-300">把项目资料、代码来源、当前状态和团队协作放在同一个受控空间中。<br className="hidden xl:block" />系统保留原始证据与引用链，帮助团队从可靠资料出发理解项目。</p>
            </div>

            <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
              <Feature icon={<DocumentIcon />} iconTone="bg-indigo-600/35 text-indigo-300" title="资料有出处">来源、文件与代码快照<br />留存内容指纹和定位信息。</Feature>
              <Feature icon={<ShieldIcon />} iconTone="bg-emerald-500/20 text-emerald-300" title="权限有边界">工作区与项目角色由服务<br />端统一校验。</Feature>
              <Feature icon={<PeopleIcon />} iconTone="bg-blue-500/20 text-blue-300" title="确认在人手">AI 只生成候选；事实、状态<br />和资料发布由人审核。</Feature>
              <Feature icon={<BoltIcon />} iconTone="bg-amber-500/20 text-amber-300" title="动作受控制">外部只读能力逐项授权、<br />逐次审批并留下审计。</Feature>
            </div>

            <div className="mt-auto flex items-start gap-3 pt-5 text-[11px] leading-5 text-slate-400">
              <span className="mt-0.5 text-slate-400"><SmallShieldIcon /></span>
              <p>当前产品聚焦可追溯资料、人工确认、项目记忆和受控只读能力。<br className="hidden xl:block" />不会替你修改代码、写入 Git、执行 Shell 或部署。</p>
            </div>
          </div>
        </section>

        <section className="order-1 flex items-center bg-[radial-gradient(circle_at_75%_15%,rgba(238,242,255,.8),transparent_36%),#fff] px-7 py-8 sm:px-12 lg:order-2 lg:px-16 lg:py-[42px]">
          <form onSubmit={submit} className="mx-auto w-full max-w-[500px]">
            <p className="text-[11px] font-bold uppercase tracking-[0.27em] text-indigo-600">Secure workspace</p>
            <h2 className="mt-3 text-[30px] font-semibold tracking-[-0.04em] sm:text-[34px]">登录 AI Project OS</h2>
            <p className="mt-2 text-[14px] leading-6 text-slate-500">使用账号登录你的工作区，继续处理项目资料与治理任务。</p>

            <label className="mt-7 block text-sm font-semibold" htmlFor="login-username">用户名</label>
            <div className="relative mt-2">
              <span className="pointer-events-none absolute inset-y-0 left-5 flex items-center text-slate-400"><UserIcon /></span>
              <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required placeholder="输入登录名" className="h-14 w-full rounded-xl border border-slate-200 bg-slate-50/80 pl-[56px] pr-5 text-[15px] outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100" />
            </div>

            <label className="mt-5 block text-sm font-semibold" htmlFor="login-password">密码</label>
            <div className="relative mt-2">
              <span className="pointer-events-none absolute inset-y-0 left-5 flex items-center text-slate-400"><LockIcon /></span>
              <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="输入密码" className="h-14 w-full rounded-xl border border-slate-200 bg-slate-50/80 pl-[56px] pr-5 text-[15px] outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100" />
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 text-[12px]">
              <label className="flex cursor-pointer items-center gap-2.5 text-slate-600">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 accent-indigo-600" />
                <span>记住我</span>
              </label>
              <button type="button" onClick={() => setHelpVisible((visible) => !visible)} className="font-semibold text-indigo-600 transition hover:text-indigo-500">忘记密码？</button>
            </div>

            {helpVisible ? <p role="status" className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm leading-6 text-indigo-700">当前部署不通过邮件重置密码。请联系工作区管理员恢复本地账户，或使用已绑定的 GitHub / 企业身份登录。</p> : null}
            {notice ? <p role={noticeTone === "error" ? "alert" : "status"} className={`mt-4 rounded-xl border px-4 py-3 text-sm ${noticeTone === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{notice}</p> : null}
            {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}

            <button type="submit" disabled={pending} className="mt-6 h-[52px] w-full rounded-xl bg-[linear-gradient(90deg,#4f35ff,#4a2df3)] px-4 text-[15px] font-semibold tracking-[0.22em] text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110 disabled:opacity-50">{pending ? "登录中…" : "登 录"}</button>

            <div className="my-5 flex items-center gap-5 text-sm text-slate-400"><span className="h-px flex-1 bg-slate-200" /><span>其他登录方式</span><span className="h-px flex-1 bg-slate-200" /></div>

            {githubLoginAvailable ? (
              <a href={githubHref} className="flex h-[52px] w-full items-center justify-center gap-4 rounded-xl border border-slate-300 bg-white text-[15px] font-semibold text-slate-900 transition hover:border-indigo-300 hover:bg-indigo-50"><GitHubIcon />使用 GitHub 登录</a>
            ) : (
              <div>
                <button type="button" disabled className="flex h-[52px] w-full items-center justify-center gap-4 rounded-xl border border-slate-200 bg-slate-50 text-[15px] font-semibold text-slate-500"><GitHubIcon />使用 GitHub 登录</button>
                <p className="mt-2 text-center text-[11px] text-slate-400">当前部署尚未配置 GitHub OAuth</p>
              </div>
            )}

            {oidcProviders.length > 0 ? <div className="mt-3 space-y-2">{oidcProviders.map((provider) => <a key={provider.id} href={`/api/auth/oidc/start/${provider.id}?returnTo=${encodeURIComponent(returnTo)}`} className="flex min-h-[52px] w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50">使用 {provider.name} 登录</a>)}</div> : null}
          </form>
        </section>
      </div>

      <footer className="mx-auto mt-6 flex max-w-[1280px] flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-400 sm:mt-7 sm:gap-x-8">
        <Link href="/privacy" className="inline-flex items-center gap-1.5 transition hover:text-indigo-600"><SmallShieldIcon />隐私政策</Link>
        <span className="h-3 w-px bg-slate-300" />
        <Link href="/terms" className="inline-flex items-center gap-1.5 transition hover:text-indigo-600"><TermsIcon />服务条款</Link>
        <span className="h-3 w-px bg-slate-300" />
        <Link href="/help" className="inline-flex items-center gap-1.5 transition hover:text-indigo-600"><HelpIcon />帮助文档</Link>
      </footer>
    </main>
  );
}

function Feature({ icon, iconTone, title, children }: { icon: ReactNode; iconTone: string; title: string; children: ReactNode }) {
  return <div className="flex min-h-[92px] items-start gap-3 rounded-2xl border border-white/15 bg-white/[.045] p-3"><span className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl ${iconTone}`}>{icon}</span><div><p className="text-[14px] font-semibold text-white">{title}</p><p className="mt-1 text-[12px] leading-5 text-slate-400">{children}</p></div></div>;
}

function UserIcon() { return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3.2" /><path d="M5.8 20v-2.1A4.9 4.9 0 0 1 10.7 13h2.6a4.9 4.9 0 0 1 4.9 4.9V20" /></svg>; }
function LockIcon() { return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5.5" y="10" width="13" height="10" rx="2" /><path d="M8.5 10V7.2a3.5 3.5 0 0 1 7 0V10" /><path d="M12 14.4v2.3" /></svg>; }
function GitHubIcon() { return <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .7A11.5 11.5 0 0 0 8.36 23.1c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.58-.29-5.29-1.29-5.29-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.72 5.38-5.3 5.67.42.36.79 1.06.79 2.14v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg>; }
function DocumentIcon() { return <svg aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 3.5h7l4 4V20H7z" /><path d="M14 3.5V8h4M10 12h5M10 15.5h5" /></svg>; }
function ShieldIcon() { return <svg aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 19 6v5c0 4.6-2.8 7.7-7 10-4.2-2.3-7-5.4-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>; }
function PeopleIcon() { return <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.2" /><path d="M3.8 19v-2a4.4 4.4 0 0 1 4.4-4.4h1.6a4.4 4.4 0 0 1 4.4 4.4v2M15.5 13.5a3.8 3.8 0 0 1 4.7 3.7V19" /></svg>; }
function BoltIcon() { return <svg aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="currentColor"><path d="M13.3 2 5.7 13h5L9.9 22 18.4 9.8h-5.2z" /></svg>; }
function SmallShieldIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 19 6v5c0 4.6-2.8 7.7-7 10-4.2-2.3-7-5.4-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>; }
function TermsIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 3.5h9l3 3V20H6z" /><path d="M15 3.5V7h3M9 11h6M9 14.5h6M9 18h4" /></svg>; }
function HelpIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M9.7 9.3a2.5 2.5 0 1 1 3.7 2.2c-.9.45-1.4 1-1.4 2" /><path d="M12 17.5h.01" /></svg>; }
