"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { UiErrorText } from "@/components/ui-error-text";
import { useTranslate } from "@/components/appearance-provider";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import { ShellIcon } from "@/components/shell-icon";
import styles from "@/components/auth-page.module.css";

export function RecoveryForm({ phoneAuthStatus }: { phoneAuthStatus: "disabled" | "unavailable" | "available" }) {
  const t = useTranslate();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const available = phoneAuthStatus === "available";

  function continueToPassword() {
    setError(null);
    if (!/^1[3-9][0-9]{9}$/u.test(phone)) {
      setError("请输入有效的中国大陆手机号。");
      return;
    }
    if (!available || !challengeId || code.length !== 6) {
      setError("请先获取并填写短信验证码。");
      return;
    }
    setStep(2);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (step === 1) {
      continueToPassword();
      return;
    }
    if (!available || !challengeId || code.length !== 6) {
      setError("请先获取并填写短信验证码。");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "找回失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  if (username !== null) return (
    <div className={styles.formBody}>
      <div role="status" className={`${styles.notice} ${styles.noticeSuccess} ${styles.successCard}`}>
        <h1 className={styles.successHeading}>{t("密码已重设")}</h1><p>{t("你的登录名：")}<strong>{username}</strong></p>
        <p>{t("所有设备已退出登录，请使用新密码重新登录。")}</p>
      </div>
      <Link href="/login?password=updated" className={styles.actionLinkButton}>{t("返回登录")}</Link>
    </div>
  );

  return (
    <form onSubmit={submit} className={`${styles.recoveryForm} ${styles.formBody}`}>
      <div className={styles.formHeading}>
        <p className={styles.formEyebrow}>{t("账户恢复")}</p>
        <h1>{t(step === 1 ? "找回账号与密码" : "设置新密码")}</h1>
        <p>{t(step === 1 ? "通过已绑定的手机号重新访问账号。" : "为账号设置新的登录密码。")}</p>
      </div>
      {!available ? <p role="status" className={`${styles.notice} ${styles.noticeWarning}`}>{t("短信找回暂不可用，请稍后重试。你也可以返回登录页，使用已绑定的 GitHub 或企业身份登录。")}</p> : null}

      <div className={styles.flowSteps} aria-label={t("第 {step} 步，共 2 步").replace("{step}", String(step))}>
        <span className={`${styles.flowStep} ${step === 1 ? styles.flowStepActive : styles.flowStepDone}`} aria-current={step === 1 ? "step" : undefined}>
          <i>{step === 1 ? "1" : <ShellIcon name="check" className="app-icon--meta" />}</i>{t("验证手机号")}
        </span>
        <span className={styles.flowConnector} />
        <span className={`${styles.flowStep} ${step === 2 ? styles.flowStepActive : ""}`} aria-current={step === 2 ? "step" : undefined}>
          <i>2</i>{t("设置新密码")}
        </span>
      </div>

      <fieldset disabled={pending || !available || step !== 1} data-hidden={step !== 1} className={`${styles.recoveryFieldset} ${styles.stepPanel}`}>
        <label htmlFor="recover-phone" className={styles.fieldLabel}>{t("已绑定的手机号")}
          <span className={styles.phoneShell}>
            <span className={styles.phonePrefix}>+86</span>
            <input
              id="recover-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              value={phone}
              minLength={11}
              maxLength={11}
              pattern="1[3-9][0-9]{9}"
              required
              placeholder={t("输入 11 位手机号")}
              onChange={(event) => { setPhone(normalizeMainlandPhoneInput(event.target.value)); setCode(""); setChallengeId(null); }}
              className={styles.phoneInput}
            />
          </span>
        </label>
        <div className={styles.smsCodeField}>
          <SmsCodeInput key={phone} id="recover-code" phoneE164={`+86${phone}`} purpose="recover" availability={available ? "available" : "unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId} />
        </div>
        {error && step === 1 ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}
        <button type="button" onClick={continueToPassword} className={styles.submitButton}>{t("继续设置新密码")}</button>
        <p className={styles.fieldHint}>{t("验证码将在重设密码时一并核验。")}</p>
      </fieldset>

      {step === 2 ? (
        <>
          <div className={styles.identitySummary}>
            <div><span>{t("待验证手机号")}</span><strong>+86 {phone}</strong></div>
            <button type="button" disabled={pending} onClick={() => { setStep(1); setError(null); }}>{t("修改")}</button>
          </div>

          <fieldset disabled={pending} className={styles.recoveryFieldset}>
            <div className={styles.passwordFields}>
              <div>
                <label htmlFor="recover-password" className={styles.fieldLabel}>{t("新密码")}</label>
                <div className={styles.passwordShell}>
                  <input id="recover-password" type={passwordVisible ? "text" : "password"} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required className={styles.passwordInput} />
                  <button type="button" className={styles.passwordToggle} aria-label={t(passwordVisible ? "隐藏密码" : "显示密码")} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((current) => !current)}><ShellIcon name={passwordVisible ? "eye-off" : "eye"} className="app-icon--control" /></button>
                </div>
                <span className={styles.fieldHint}>{t("8–128 位，包含字母和数字。")}</span>
              </div>
              <div>
                <label htmlFor="recover-confirmation" className={styles.fieldLabel}>{t("再次输入新密码")}</label>
                <div className={styles.passwordShell}>
                  <input id="recover-confirmation" type={confirmationVisible ? "text" : "password"} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} maxLength={128} required className={styles.passwordInput} />
                  <button type="button" className={styles.passwordToggle} aria-label={t(confirmationVisible ? "隐藏密码" : "显示密码")} aria-pressed={confirmationVisible} onClick={() => setConfirmationVisible((current) => !current)}><ShellIcon name={confirmationVisible ? "eye-off" : "eye"} className="app-icon--control" /></button>
                </div>
              </div>
            </div>
            <p className={styles.recoveryHint}>{t("重设成功后，所有设备将退出登录。")}</p>
            {error && step === 2 ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}
            <button disabled={!challengeId || code.length !== 6 || !password || !confirmation || pending} className={styles.submitButton}>{pending ? t("正在验证…") : t("验证并重设密码")}</button>
          </fieldset>
        </>
      ) : null}
      <Link href="/login" className={styles.formReturnLink}>{t("返回登录")}</Link>
    </form>
  );
}
