"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
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
      <div className="mx-auto max-w-5xl px-5 pb-16 pt-9 sm:px-8 lg:px-10">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Account</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">个人中心</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">查看账户状态，管理登录名和密码。</p>
        </section>

        {error ? <div role="alert" className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重试</button></div> : null}

        <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-xl font-bold text-white shadow-lg shadow-indigo-500/20">{headerUsername.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold tracking-[-0.02em]">{headerUsername}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-semibold text-indigo-700">本地管理员</span>
                  <span className="text-slate-400">账户数据仅保存在当前部署</span>
                </div>
              </div>
            </div>
            <LogoutButton className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 sm:w-auto" />
          </div>

          {loading || !profile ? (
            <div className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
              {[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse bg-slate-50 p-5"><div className="h-3 w-16 rounded bg-slate-200" /><div className="mt-3 h-5 w-28 rounded bg-slate-200" /></div>)}
            </div>
          ) : (
            <dl className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
              <StatusItem label="最近活动" value={formatDate(profile.lastSeenAt)} />
              <StatusItem label="活动会话" value={`${profile.activeSessionCount} 个`} />
              <StatusItem label="登录状态" value="已登录" tone="success" />
            </dl>
          )}

          <details className="group border-t border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-sm transition hover:bg-slate-50 sm:px-7">
              <span><span className="font-semibold text-slate-700">账户详情</span><span className="ml-2 text-slate-400">创建时间与最近会话有效期</span></span>
              <span aria-hidden="true" className="text-lg text-slate-400 transition group-open:rotate-180">⌄</span>
            </summary>
            {profile ? (
              <div className="grid gap-4 border-t border-slate-100 bg-slate-50/70 px-6 py-5 text-sm sm:grid-cols-2 sm:px-7">
                <DetailItem label="创建时间" value={formatDate(profile.createdAt)} />
                <DetailItem label="最近活动会话到期" value={formatDate(profile.sessionExpiresAt)} />
              </div>
            ) : null}
          </details>
        </section>

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="px-6 py-6 sm:px-7">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Account settings</p>
            <h2 className="mt-2 text-xl font-semibold">登录与安全</h2>
          </div>
          <UsernameForm key={profile?.username ?? "loading"} profile={profile} loading={loading} onUpdated={(username) => { setHeaderUsername(username); setProfile((current) => current ? { ...current, username } : current); router.refresh(); }} />
          <PasswordForm />
        </section>

        <section className="mt-5 flex flex-col gap-4 rounded-2xl border border-slate-200/80 bg-white/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">服务凭据分开管理</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">个人中心不会展示或导出 API Key 与 GitHub PAT。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CredentialLink href="/settings">模型 API Key</CredentialLink>
            <CredentialLink href="/dashboard#projects">GitHub PAT</CredentialLink>
          </div>
        </section>
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

  return (
    <section className="grid gap-5 border-t border-slate-100 px-6 py-6 sm:grid-cols-[0.72fr_1.28fr] sm:px-7">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">登录名</h3>
        <p className="mt-1.5 text-xs leading-5 text-slate-400">用于登录当前本地部署，修改后下次登录生效。</p>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="profile-username" className="sr-only">登录名</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" required disabled={loading || !profile} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" />
          <button disabled={pending || loading || !profile || username === profile.username} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-40">{pending ? "保存中…" : "保存"}</button>
        </div>
        <p className="mt-2 text-xs text-slate-400">3–64 位，可使用字母、数字、点、下划线和连字符。</p>
        {message ? <Message {...message} /> : null}
      </form>
    </section>
  );
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

  return (
    <details className="group border-t border-slate-100">
      <summary className="grid cursor-pointer list-none gap-4 px-6 py-6 transition hover:bg-slate-50 sm:grid-cols-[0.72fr_1.28fr] sm:px-7">
        <span>
          <span className="block text-sm font-semibold text-slate-800">修改密码</span>
          <span className="mt-1.5 block text-xs leading-5 text-slate-400">仅在需要轮换密码时展开。</span>
        </span>
        <span className="flex items-center justify-between gap-4">
          <span className="text-xs leading-5 text-slate-500">更新后会撤销全部登录会话，并要求重新登录。</span>
          <span aria-hidden="true" className="shrink-0 text-lg text-slate-400 transition group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <form onSubmit={submit} className="grid gap-4 border-t border-slate-100 bg-slate-50/70 px-6 py-6 sm:px-7">
        <PasswordField id="profile-current-password" label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
        <div className="grid gap-4 sm:grid-cols-2">
          <PasswordField id="profile-new-password" label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
          <PasswordField id="profile-confirm-password" label="再次输入新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
        </div>
        <p className="text-xs text-slate-400">新密码至少 12 位，并同时包含字母和数字。</p>
        {message ? <Message {...message} /> : null}
        <div><button disabled={pending || !currentPassword || !newPassword || !confirmPassword} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500 disabled:opacity-40">{pending ? "正在更新…" : "更新密码并重新登录"}</button></div>
      </form>
    </details>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label htmlFor={id} className="text-sm font-semibold text-slate-700">{label}<input id={id} type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>;
}

function StatusItem({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" }) {
  return <div className="bg-slate-50/80 px-6 py-5 sm:px-7"><dt className="text-xs font-medium text-slate-400">{label}</dt><dd className={`mt-2 text-sm font-semibold ${tone === "success" ? "text-emerald-700" : "text-slate-700"}`}>{value}</dd></div>;
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 font-medium text-slate-700">{value}</dd></div>;
}

function Message({ tone, text }: { tone: "success" | "error"; text: string }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`mt-4 rounded-xl px-4 py-3 text-sm ${tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{text}</p>;
}

function CredentialLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700">{children} ↗</Link>;
}
