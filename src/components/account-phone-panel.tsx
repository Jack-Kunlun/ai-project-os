"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";

export function AccountPhonePanel({ phoneE164, hasLocalPassword, phoneAuthStatus }: {
  phoneE164: string | null; hasLocalPassword: boolean; phoneAuthStatus: "disabled" | "unavailable" | "available";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [oldCode, setOldCode] = useState("");
  const [oldChallengeId, setOldChallengeId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changing = phoneE164 !== null;
  const available = phoneAuthStatus === "available";
  const maskedPhone = phoneE164 ? `${phoneE164.slice(0, 6)} **** ${phoneE164.slice(-4)}` : "尚未绑定";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    if (!available || !challengeId || code.length !== 6) { setError("请先验证新手机号。"); return; }
    if (changing && (!oldChallengeId || oldCode.length !== 6)) { setError("请填写原手机号的验证码。"); return; }
    setPending(true);
    try {
      const response = await fetch("/api/auth/phone", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: `+86${phone}`, challengeId, code, ...(changing
          ? { action: "change", oldPhone: phoneE164, oldChallengeId, oldCode }
          : { action: "bind", currentPassword: password }) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "手机号更新失败，请重新验证。");
      }
      setPassword(""); setCode(""); setOldCode("");
      router.replace("/login?phone=updated"); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "手机号更新失败。"); setPending(false); }
  }

  function cancel() {
    setOpen(false); setPhone(""); setCode(""); setOldCode(""); setPassword(""); setChallengeId(null); setOldChallengeId(null); setError(null);
  }

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
      <h2 className="text-lg font-semibold">绑定手机号</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{maskedPhone}。绑定后可用于登录和找回密码。</p>
      {!available ? <p role="status" className="mt-3 text-sm leading-6 text-amber-800">短信服务暂不可用，请稍后重试。</p> : null}
      {!changing && !hasLocalPassword ? <p className="mt-3 text-sm leading-6 text-slate-600">请先设置本地密码并重新登录，再验证密码和手机号完成绑定。</p> : null}
      {!open ? <button type="button" disabled={!available || (!changing && !hasLocalPassword)} onClick={() => setOpen(true)} className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 disabled:opacity-50">{changing ? "更换手机号" : "绑定手机号"}</button> : (
        <form onSubmit={submit} className="mt-5 max-w-xl">
          <fieldset disabled={pending || !available} className="space-y-5">
            {changing ? <div><p className="mb-2 text-sm font-semibold">验证原手机号 {maskedPhone}</p><SmsCodeInput id="phone-old-code" phoneE164={phoneE164} purpose="change-old" availability={available ? "available" : "unavailable"} code={oldCode} onCodeChange={setOldCode} onChallengeIdChange={setOldChallengeId} /></div>
              : <label htmlFor="phone-current-password" className="block text-sm font-semibold">当前登录密码<input id="phone-current-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} required className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 font-normal outline-none focus:border-indigo-400" /></label>}
            <label htmlFor="phone-new-number" className="block text-sm font-semibold">{changing ? "新手机号" : "手机号"}<span className="mt-2 flex overflow-hidden rounded-xl border border-slate-200 bg-slate-50"><span className="flex items-center border-r border-slate-200 px-3 text-slate-500">+86</span><input id="phone-new-number" type="tel" inputMode="numeric" autoComplete="tel-national" value={phone} onChange={(event) => { setPhone(normalizeMainlandPhoneInput(event.target.value)); setCode(""); setChallengeId(null); }} minLength={11} maxLength={11} pattern="1[3-9][0-9]{9}" required placeholder="输入 11 位手机号" className="h-11 min-w-0 flex-1 bg-transparent px-3 font-normal outline-none focus:bg-white" /></span></label>
            <SmsCodeInput key={phone} id="phone-new-code" phoneE164={`+86${phone}`} purpose={changing ? "change-new" : "bind"} availability={available ? "available" : "unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId} />
            <p className="text-xs leading-6 text-slate-500">{changing ? "需同时验证原号码和新号码。原号码不可用时，暂无法自助换绑。" : "绑定需要验证当前密码及手机号。"}操作成功后，所有设备需重新登录。</p>
            <div className="flex flex-wrap gap-3"><button disabled={!challengeId || code.length !== 6 || (changing ? !oldChallengeId || oldCode.length !== 6 : !password)} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "正在验证…" : changing ? "确认换绑并重新登录" : "确认绑定并重新登录"}</button><button type="button" onClick={cancel} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600">取消</button></div>
          </fieldset>
          {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-800">{error}</p> : null}
        </form>
      )}
    </section>
  );
}
