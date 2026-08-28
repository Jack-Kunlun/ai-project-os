"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LogoutButton } from "@/app/logout-button";
import { AppHeader } from "@/components/app-header";

type Profile = {
  id: string;
  username: string;
  role: "admin";
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  lastSeenAt: string | null;
  sessionExpiresAt: string | null;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

export function ProfileClient({ username: initialUsername }: { username: string }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [headerUsername, setHeaderUsername] = useState(initialUsername);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "个人信息加载失败"));
      const next = (await response.json() as { profile: Profile }).profile;
      setProfile(next);
      setHeaderUsername(next.username);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "个人信息加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={headerUsername} active="profile" />
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-9 sm:px-8 lg:px-10">
        <section className="flex flex-col gap-5 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Personal center</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">个人中心</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">管理本地管理员身份与登录安全。模型凭据仍在“模型设置”中单独管理。</p>
          </div>
          <Link href="/settings" className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-indigo-200 hover:text-indigo-700">前往模型设置</Link>
        </section>

        {error ? <div role="alert" className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重试</button></div> : null}

        <div className="mt-7 grid gap-6 lg:grid-cols-[0.7fr_1.3fr]">
          <aside className="space-y-6">
            <section className="relative overflow-hidden rounded-3xl bg-slate-950 p-7 text-white shadow-xl shadow-slate-950/10">
              <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-indigo-500/30 blur-3xl" />
              <div className="relative">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-violet-600 text-2xl font-bold shadow-lg">{headerUsername.slice(0, 1).toUpperCase()}</span>
                <h2 className="mt-5 truncate text-2xl font-semibold">{headerUsername}</h2>
                <p className="mt-1 text-sm text-slate-400">本地管理员</p>
                <div className="mt-6 border-t border-white/10 pt-5">
                  <p className="text-xs leading-6 text-slate-400">当前版本采用本地单管理员模式，账户数据只保存在这套部署中。</p>
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-800">账户状态</h2>
              {loading || !profile ? <div className="mt-5 space-y-3">{[1, 2, 3].map((item) => <div key={item} className="h-10 animate-pulse rounded-xl bg-slate-100" />)}</div> : <dl className="mt-5 space-y-4 text-sm"><InfoRow label="账户类型" value="本地管理员" /><InfoRow label="创建时间" value={formatDate(profile.createdAt)} /><InfoRow label="最近活动" value={formatDate(profile.lastSeenAt)} /><InfoRow label="活动会话" value={`${profile.activeSessionCount} 个`} /><InfoRow label="最近会话到期" value={formatDate(profile.sessionExpiresAt)} /></dl>}
            </section>

            <LogoutButton className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50" />
          </aside>

          <div className="space-y-6">
            <UsernameForm key={profile?.username ?? "loading"} profile={profile} loading={loading} onUpdated={(username) => { setHeaderUsername(username); setProfile((current) => current ? { ...current, username } : current); router.refresh(); }} />
            <PasswordForm />
            <section className="rounded-3xl border border-indigo-100 bg-indigo-50/70 p-6 sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Account boundaries</p>
              <h2 className="mt-2 text-xl font-semibold">哪些内容不在个人中心管理</h2>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <BoundaryCard title="模型 API Key" detail="在模型设置中加密保存、测试和轮换。" href="/settings" />
                <BoundaryCard title="GitHub PAT" detail="在具体项目的智能控制台中按项目管理。" href="/dashboard#projects" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function UsernameForm({ profile, loading, onUpdated }: { profile: Profile | null; loading: boolean; onUpdated: (username: string) => void }) {
  const [username, setUsername] = useState(profile?.username ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateUsername", username }) });
      if (!response.ok) throw new Error(await readError(response, "登录名更新失败"));
      const next = (await response.json() as { user: { username: string } }).user.username;
      onUpdated(next);
      setMessage({ tone: "success", text: "登录名已更新，下次请使用新登录名。" });
    } catch (submitError) {
      setMessage({ tone: "error", text: submitError instanceof Error ? submitError.message : "登录名更新失败" });
    } finally {
      setPending(false);
    }
  }

  return <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Identity</p><h2 className="mt-2 text-xl font-semibold">登录信息</h2><p className="mt-2 text-sm leading-6 text-slate-500">登录名支持字母、数字、点、下划线和连字符，长度为 3–64 位。</p></div><form onSubmit={submit} className="mt-6"><label htmlFor="profile-username" className="text-sm font-semibold text-slate-700">登录名</label><div className="mt-2 flex flex-col gap-3 sm:flex-row"><input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" required disabled={loading || !profile} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" /><button disabled={pending || loading || !profile || username === profile.username} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-40">{pending ? "保存中…" : "保存登录名"}</button></div>{message ? <Message {...message} /> : null}</form></section>;
}

function PasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ tone: "error", text: "两次输入的新密码不一致" });
      return;
    }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "changePassword", currentPassword, newPassword }) });
      if (!response.ok) throw new Error(await readError(response, "密码更新失败"));
      router.replace("/login?password=updated");
      router.refresh();
    } catch (submitError) {
      setMessage({ tone: "error", text: submitError instanceof Error ? submitError.message : "密码更新失败" });
      setPending(false);
    }
  }

  return <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Security</p><h2 className="mt-2 text-xl font-semibold">修改密码</h2><p className="mt-2 text-sm leading-6 text-slate-500">新密码至少 12 位，并同时包含字母和数字。修改成功后会撤销全部登录会话，需要重新登录。</p></div><form onSubmit={submit} className="mt-6 grid gap-4"><PasswordField id="profile-current-password" label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><div className="grid gap-4 sm:grid-cols-2"><PasswordField id="profile-new-password" label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" /><PasswordField id="profile-confirm-password" label="再次输入新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" /></div>{message ? <Message {...message} /> : null}<div><button disabled={pending || !currentPassword || !newPassword || !confirmPassword} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500 disabled:opacity-40">{pending ? "正在更新…" : "更新密码并重新登录"}</button></div></form></section>;
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label htmlFor={id} className="text-sm font-semibold text-slate-700">{label}<input id={id} type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 last:pb-0"><dt className="text-slate-400">{label}</dt><dd className="text-right font-medium text-slate-700">{value}</dd></div>;
}

function Message({ tone, text }: { tone: "success" | "error"; text: string }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`mt-4 rounded-xl px-4 py-3 text-sm ${tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{text}</p>;
}

function BoundaryCard({ title, detail, href }: { title: string; detail: string; href: string }) {
  return <Link href={href} className="rounded-2xl border border-white bg-white/80 p-4 transition hover:border-indigo-200"><span className="text-sm font-semibold text-slate-800">{title}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{detail}</span></Link>;
}
