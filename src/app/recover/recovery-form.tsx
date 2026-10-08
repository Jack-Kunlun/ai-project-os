"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";

export function RecoveryForm({ phoneAuthStatus }: { phoneAuthStatus: "disabled" | "unavailable" | "available" }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const available = phoneAuthStatus === "available";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!available || !challengeId || code.length !== 6) { setError("请先获取并填写短信验证码。"); return; }
    if (password !== confirmation) { setError("两次输入的密码不一致。"); return; }
    setPending(true);
    try {
      const response = await fetch("/api/auth/recovery", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: `+86${phone}`, challengeId, code, newPassword: password }),
      });
      const payload = await response.json().catch(() => null) as { username?: string; error?: { message?: string } } | null;
      if (!response.ok || typeof payload?.username !== "string") throw new Error(payload?.error?.message ?? "找回失败，请检查验证码或重新获取。");
      setUsername(payload.username);
      setPassword(""); setConfirmation(""); setCode(""); setChallengeId(null); setPhone("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "找回失败，请稍后重试。"); }
    finally { setPending(false); }
  }

  if (username !== null) return (
    <div className="mt-6">
      <div role="status" className="rounded-2xl bg-emerald-50 p-5 text-sm leading-7 text-emerald-900">
        <p className="font-semibold">密码已重设</p><p>你的登录名：<strong className="break-all">{username}</strong></p>
        <p>所有设备已退出登录，请使用新密码重新登录。</p>
      </div>
      <Link href="/login?password=updated" className="mt-5 flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white">返回登录</Link>
    </div>
  );

  return (
    <form onSubmit={submit} className="mt-6">
      {!available ? <p role="status" className="mb-5 rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">短信找回暂不可用，请稍后重试。你也可以返回登录页，使用已绑定的 GitHub 或企业身份登录。</p> : null}
      <fieldset disabled={pending || !available} className="space-y-5">
        <label htmlFor="recover-phone" className="block text-sm font-semibold">已绑定的手机号
          <span className="mt-2 flex overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            <span className="flex items-center border-r border-slate-200 px-3 text-slate-500">+86</span>
            <input id="recover-phone" type="tel" inputMode="numeric" autoComplete="tel-national" value={phone} minLength={11} maxLength={11} pattern="1[3-9][0-9]{9}" required placeholder="输入 11 位手机号" onChange={(event) => { setPhone(normalizeMainlandPhoneInput(event.target.value)); setCode(""); setChallengeId(null); }} className="h-11 min-w-0 flex-1 bg-transparent px-3 font-normal outline-none focus:bg-white" />
          </span>
        </label>
        <SmsCodeInput key={phone} id="recover-code" phoneE164={`+86${phone}`} purpose="recover" availability={available ? "available" : "unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId} />
        <label htmlFor="recover-password" className="block text-sm font-semibold">新密码<input id="recover-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} required className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 font-normal outline-none focus:border-indigo-400" /><span className="mt-2 block text-xs font-normal leading-5 text-slate-500">12–128 位，包含字母和数字。</span></label>
        <label htmlFor="recover-confirmation" className="block text-sm font-semibold">再次输入新密码<input id="recover-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} maxLength={128} required className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 font-normal outline-none focus:border-indigo-400" /></label>
        <p className="text-xs leading-6 text-slate-500">重设成功后会退出所有设备。没有绑定手机号或号码已不可用时，请使用已绑定的其他登录方式；此处无法变更账号归属。</p>
        <button disabled={!challengeId || code.length !== 6 || !password || !confirmation} className="flex min-h-11 w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "正在验证…" : "验证并重设密码"}</button>
      </fieldset>
      {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-800">{error}</p> : null}
      <Link href="/login" className="mt-5 block text-center text-sm font-semibold text-indigo-600">返回登录</Link>
    </form>
  );
}
