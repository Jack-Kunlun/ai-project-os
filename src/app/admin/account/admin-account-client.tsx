"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader } from "@/components/admin-page-header";

type AdminProfile = Readonly<{
  username: string;
  displayName: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  hasLocalPassword: boolean;
  activeSessionCount: number;
  lastSeenAt: string | null;
}>;

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function dateTime(value: string | null): string {
  return value === null ? "暂无记录" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AdminAccountClient({ initialUsername }: { initialUsername: string }) {
  const router = useRouter();
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/account", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response, "管理员账户读取失败"));
    const next = (await response.json() as { profile: AdminProfile }).profile;
    setProfile(next);
    setDisplayName(next.displayName ?? "");
    setEmail(next.email ?? "");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "管理员账户读取失败")), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/account", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateProfile", displayName: displayName || null, email: email || null }) });
      if (!response.ok) throw new Error(await responseMessage(response, "账户资料保存失败"));
      await load(); setMessage("账户资料已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "账户资料保存失败"); }
    finally { setPending(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/account", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: profile?.hasLocalPassword ? "changePassword" : "setLocalPassword", ...(profile?.hasLocalPassword ? { currentPassword } : {}), newPassword }) });
      if (!response.ok) throw new Error(await responseMessage(response, "密码更新失败"));
      router.replace("/login"); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "密码更新失败"); setPending(false); }
  }

  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="管理员账户" description="维护平台管理员的登录资料与密码；这里不显示项目、团队、工作区角色、个人连接或业务额度。" />
    {message ? <p role="status" className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">{message}</p> : null}
    <section className="mt-6 grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-3">
      <div><p className="text-xs font-semibold text-slate-400">登录名</p><p className="mt-2 font-semibold">{profile?.username ?? initialUsername}</p></div>
      <div><p className="text-xs font-semibold text-slate-400">活动会话</p><p className="mt-2 font-semibold">{profile ? `${profile.activeSessionCount} 个` : "读取中…"}</p></div>
      <div><p className="text-xs font-semibold text-slate-400">最近活动</p><p className="mt-2 text-sm font-semibold">{profile ? dateTime(profile.lastSeenAt) : "读取中…"}</p></div>
    </section>
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <form onSubmit={updateProfile} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">基本资料</h2>
        <label className="mt-5 block text-sm font-medium text-slate-700">显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={160} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
        <label className="mt-4 block text-sm font-medium text-slate-700">邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
        <button disabled={pending || profile === null} className="mt-5 min-h-11 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">保存资料</button>
      </form>
      <form onSubmit={changePassword} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">登录密码</h2>
        {profile?.hasLocalPassword ? <label className="mt-5 block text-sm font-medium text-slate-700">当前密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label> : null}
        <label className="mt-4 block text-sm font-medium text-slate-700">新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
        <p className="mt-2 text-xs leading-5 text-slate-500">至少 12 位，同时包含字母和数字。更新后需要重新登录。</p>
        <button disabled={pending || profile === null} className="mt-5 min-h-11 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">更新密码</button>
      </form>
    </div>
  </div>;
}
