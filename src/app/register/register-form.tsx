"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import { EmailCodeInput } from "@/components/email-code-input";

type PhoneAuthStatus = "disabled" | "unavailable" | "available";
type EmailAuthStatus = "disabled" | "unavailable" | "available";

type RegisterFormProps = {
  localRegistrationEnabled: boolean;
  phoneAuthStatus?: PhoneAuthStatus;
  emailAuthStatus?: EmailAuthStatus;
};

export function RegisterForm({ localRegistrationEnabled, phoneAuthStatus = "disabled", emailAuthStatus = "disabled" }: RegisterFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsChallengeId, setSmsChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [method, setMethod] = useState<"email" | "phone" | "legacy">(() => emailAuthStatus !== "disabled" ? "email" : phoneAuthStatus !== "disabled" ? "phone" : "legacy");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailAvailable = emailAuthStatus !== "disabled";
  const phoneAvailable = phoneAuthStatus !== "disabled";
  const emailVerificationRequired = method === "email";
  const phoneVerificationRequired = method === "phone";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    if (emailVerificationRequired && emailAuthStatus !== "available") {
      setError("邮箱验证暂不可用，请稍后重试或联系管理员。");
      return;
    }
    if (phoneVerificationRequired && phoneAuthStatus !== "available") {
      setError("手机号验证暂不可用，请稍后重试或联系管理员。");
      return;
    }
    if (emailVerificationRequired && (!emailChallengeId || emailCode.length !== 6)) {
      setError("请先获取并填写邮箱验证码。");
      return;
    }
    if (phoneVerificationRequired && (!smsChallengeId || smsCode.length !== 6)) {
      setError("请先获取并填写短信验证码。");
      return;
    }
    setPending(true);
    try {
      const phoneE164 = phoneVerificationRequired ? `+86${phone}` : undefined;
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          remember,
          ...(emailVerificationRequired && emailChallengeId ? { method: "email", email, challengeId: emailChallengeId, code: emailCode } : {}),
          ...(phoneE164 && smsChallengeId ? { phone: phoneE164, challengeId: smsChallengeId, code: smsCode } : {}),
        }),
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

  return (
    <div className="mt-4">
      {localRegistrationEnabled ? <form onSubmit={submit}>
      <fieldset disabled={pending}>
      <div>
        <div>
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
        className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
      />
      <p className="mt-1.5 text-xs leading-5 text-slate-500">3–64 位，支持字母、数字和 . _ -；统一为小写。</p>

        </div>
      {emailAvailable && phoneAvailable ? <fieldset className="mt-3 flex gap-5 text-sm text-slate-700"><legend className="mb-2 font-semibold">注册验证方式</legend><label className="flex items-center gap-2"><input type="radio" name="registration-method" checked={method === "email"} onChange={() => { setMethod("email"); setEmailCode(""); setEmailChallengeId(null); setSmsCode(""); setSmsChallengeId(null); }} /> 邮箱</label><label className="flex items-center gap-2"><input type="radio" name="registration-method" checked={method === "phone"} onChange={() => { setMethod("phone"); setEmailCode(""); setEmailChallengeId(null); setSmsCode(""); setSmsChallengeId(null); }} /> 手机号</label></fieldset> : null}
      {emailVerificationRequired ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="register-email" className="block text-sm font-semibold">邮箱</label>
            <input id="register-email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setEmailCode(""); setEmailChallengeId(null); }} autoComplete="email" maxLength={320} required placeholder="输入常用邮箱" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100" />
            <p className="mt-1 text-xs leading-5 text-slate-500">验证码用于验证邮箱；系统不会提供邮件找回密码。</p>
          </div>
          <EmailCodeInput key={email} id="register-email-code" email={email} purpose="register" availability={emailAuthStatus === "available" ? "available" : "unavailable"} code={emailCode} onCodeChange={setEmailCode} onChallengeIdChange={setEmailChallengeId} />
        </div>
      ) : null}
      {phoneVerificationRequired ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="register-phone" className="block text-sm font-semibold">手机号</label>
            <div className="mt-2 flex h-10 w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50/80 transition focus-within:border-indigo-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-indigo-100">
              <span aria-hidden="true" className="flex shrink-0 items-center border-r border-slate-200 px-3 text-sm text-slate-500">+86</span>
              <input
                id="register-phone"
                type="tel"
                inputMode="numeric"
                value={phone}
                onChange={(event) => {
                  setPhone(normalizeMainlandPhoneInput(event.target.value));
                  setSmsCode("");
                  setSmsChallengeId(null);
                }}
                autoComplete="tel-national"
                minLength={11}
                maxLength={11}
                required
                pattern="1[3-9][0-9]{9}"
                placeholder="输入 11 位手机号"
                className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none"
              />
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">仅支持中国大陆手机号。</p>
          </div>
          <SmsCodeInput
            key={phone}
            id="register-sms-code"
            phoneE164={`+86${phone}`}
            purpose="register"
            availability={phoneAuthStatus === "available" ? "available" : "unavailable"}
            code={smsCode}
            onCodeChange={setSmsCode}
            onChallengeIdChange={setSmsChallengeId}
          />
        </div>
      ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="register-password" className="block text-sm font-semibold">密码</label>
          <input
            id="register-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
          />
          <p className="mt-1.5 text-xs leading-5 text-slate-500">8–128 位，并同时包含英文字母和数字。</p>

        </div>
        <div>
          <label htmlFor="register-confirm-password" className="block text-sm font-semibold">确认密码</label>
          <input
            id="register-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
          />

        </div>
      </div>

      <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm text-slate-600">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 accent-indigo-600" />
        <span>保持登录</span>
      </label>

      </fieldset>

      <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-900">{emailVerificationRequired ? "注册邮箱将作为验证邮箱；验证后的邮箱可用于密码登录，修改密码时需要验证当前邮箱。" : phoneVerificationRequired ? "注册手机号验证后可用于账号安全操作。" : "请妥善保管用户名和密码；当前没有可用的邮箱或手机号验证通道。"}</p>
      {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}

      <button type="submit" disabled={pending || (emailVerificationRequired && emailAuthStatus !== "available") || (phoneVerificationRequired && phoneAuthStatus !== "available")} className="mx-auto mt-3 block h-11 w-full max-w-xs rounded-xl bg-[linear-gradient(90deg,#4f35ff,#4a2df3)] px-4 text-center text-base font-semibold tracking-[0.16em] text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110 disabled:opacity-50">{pending ? "正在创建账号…" : "创建账号"}</button>
      </form> : <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">本地用户名和密码注册暂未开放。请返回登录页使用其他可用方式，或联系管理员。</p>}
    </div>
  );
}
