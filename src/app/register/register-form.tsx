"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type RegisterFormProps = {
  localRegistrationEnabled: boolean;
  githubLoginAvailable: boolean;
  githubAvailability: "notConfigured" | "configurationInvalid" | "bootstrapPending" | "available";
  githubMessage?: string;
};

export function RegisterForm({ localRegistrationEnabled, githubLoginAvailable, githubAvailability, githubMessage }: RegisterFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "注册失败，请稍后重试。");
      }
      router.replace("/dashboard");
      router.refresh();
    } catch (registrationError) {
      setError(registrationError instanceof Error ? registrationError.message : "注册失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  const githubHref = `/api/auth/github/start?intent=login&remember=${remember ? "true" : "false"}&returnTo=${encodeURIComponent("/dashboard")}`;
  const githubUnavailableMessage = {
    notConfigured: "GitHub 登录尚未配置，请联系工作区管理员。",
    configurationInvalid: "GitHub 登录配置无效，请联系工作区管理员。",
    bootstrapPending: "平台管理员尚未完成初始化，GitHub 登录暂不可用。",
    available: "",
  }[githubAvailability];

  return (
    <div className="mt-7">
      {localRegistrationEnabled ? <form onSubmit={submit}>
      <label htmlFor="register-username" className="block text-sm font-semibold">用户名</label>
      <input
        id="register-username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        minLength={3}
        maxLength={64}
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
        title="3 至 64 个字符，以字母或数字开头，只能使用字母、数字、点、下划线和连字符。"
        placeholder="例如 project.owner"
        className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
      />
      <p className="mt-1.5 text-xs leading-5 text-slate-500">用户名会统一转换为小写；3 至 64 个字符，可用字母、数字、点、下划线和连字符。</p>

      <label htmlFor="register-password" className="mt-5 block text-sm font-semibold">密码</label>
      <input
        id="register-password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
      />
      <p className="mt-1.5 text-xs leading-5 text-slate-500">至少 12 个字符，并同时包含英文字母和数字。</p>

      <label htmlFor="register-confirm-password" className="mt-5 block text-sm font-semibold">确认密码</label>
      <input
        id="register-confirm-password"
        type="password"
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
      />

      <label className="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-slate-600">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 accent-indigo-600" />
        <span>保持登录</span>
      </label>

      <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">本地注册不收集邮箱，因此暂不能通过邮箱邀请加入其他工作区，也没有邮件验证或邮件找回密码。请妥善保管用户名和密码；忘记密码时需联系管理员。</p>
      {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}

      <button type="submit" disabled={pending} className="mt-6 h-[52px] w-full rounded-xl bg-[linear-gradient(90deg,#4f35ff,#4a2df3)] px-4 text-base font-semibold tracking-[0.16em] text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110 disabled:opacity-50">{pending ? "正在创建账号…" : "创建账号"}</button>
      </form> : <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">本地用户名和密码注册暂未开放。请使用下方可用的登录方式，或联系管理员。</p>}

      <div className="my-5 flex items-center gap-4 text-sm text-slate-400"><span className="h-px flex-1 bg-slate-200" /><span>或使用 GitHub</span><span className="h-px flex-1 bg-slate-200" /></div>
      {githubLoginAvailable ? (
        <div>
          <a href={githubHref} className="flex h-[52px] w-full items-center justify-center rounded-xl border border-slate-300 bg-white text-base font-semibold text-slate-900 transition hover:border-indigo-300 hover:bg-indigo-50">使用 GitHub 注册或登录</a>
          <p className="mt-2 text-center text-xs text-slate-400">首次 GitHub 登录会创建普通用户账号；已有绑定身份会直接登录。</p>
        </div>
      ) : (
        <div>
          <button type="button" disabled className="flex h-[52px] w-full items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-base font-semibold text-slate-500">使用 GitHub 注册或登录</button>
          <p className="mt-2 text-center text-xs text-slate-400">{githubUnavailableMessage}</p>
        </div>
      )}
      {githubMessage ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{githubMessage}</p> : null}
    </div>
  );
}
