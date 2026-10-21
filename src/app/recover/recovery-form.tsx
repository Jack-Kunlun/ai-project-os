"use client";
import { UiErrorText } from "@/components/ui-error-text";


import Link from "next/link";
import { useState, type FormEvent } from "react";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import styles from "@/components/auth-page.module.css";
import { useTranslate } from "@/components/appearance-provider";

export function RecoveryForm({ phoneAuthStatus }: { phoneAuthStatus: "disabled" | "unavailable" | "available" }) {
  const t = useTranslate();
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
    <div className={styles.formBody}>
      <div role="status" className={`${styles.notice} ${styles.noticeSuccess} ${styles.successCard}`}>
        <p><strong>{t("密码已重设")}</strong></p><p>{t("你的登录名：")}<strong>{username}</strong></p>
        <p>{t("所有设备已退出登录，请使用新密码重新登录。")}</p>
      </div>
      <Link href="/login?password=updated" className={styles.actionLinkButton}>{t("返回登录")}</Link>
    </div>
  );

  return (
    <form onSubmit={submit} className={`${styles.recoveryForm} ${styles.formBody}`}>
      {!available ? <p role="status" className={`${styles.notice} ${styles.noticeWarning}`}>{t("短信找回暂不可用，请稍后重试。你也可以返回登录页，使用已绑定的 GitHub 或企业身份登录。")}</p> : null}
      <fieldset disabled={pending || !available} className={styles.recoveryFieldset}>
        <label htmlFor="recover-phone" className={styles.fieldLabel}>{t("已绑定的手机号")}
          <span className={styles.phoneShell}>
            <span className={styles.phonePrefix}>+86</span>
            <input id="recover-phone" type="tel" inputMode="numeric" autoComplete="tel-national" value={phone} minLength={11} maxLength={11} pattern="1[3-9][0-9]{9}" required placeholder={t("输入 11 位手机号")} onChange={(event) => { setPhone(normalizeMainlandPhoneInput(event.target.value)); setCode(""); setChallengeId(null); }} className={styles.phoneInput} />
          </span>
        </label>
        <div className={styles.smsCodeField}><SmsCodeInput key={phone} id="recover-code" phoneE164={`+86${phone}`} purpose="recover" availability={available ? "available" : "unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId} /></div>
        <label htmlFor="recover-password" className={styles.fieldLabel}>{t("新密码")}<input id="recover-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required className={styles.fieldInput} /><span className={styles.fieldHint}>{t("8–128 位，包含字母和数字。")}</span></label>
        <label htmlFor="recover-confirmation" className={styles.fieldLabel}>{t("再次输入新密码")}<input id="recover-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} maxLength={128} required className={styles.fieldInput} /></label>
        <p className={styles.recoveryHint}>{t("重设成功后会退出所有设备。没有绑定手机号或号码已不可用时，请使用已绑定的其他登录方式；此处无法变更账号归属。")}</p>
        <button disabled={!challengeId || code.length !== 6 || !password || !confirmation} className={styles.submitButton}>{pending ? t("正在验证…") : t("验证并重设密码")}</button>
      </fieldset>
      {error ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}
      <Link href="/login" className={styles.formReturnLink}>{t("返回登录")}</Link>
    </form>
  );
}
