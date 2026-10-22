"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UiErrorText } from "@/components/ui-error-text";
import { useTranslate } from "@/components/appearance-provider";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import { EmailCodeInput } from "@/components/email-code-input";
import { ShellIcon } from "@/components/shell-icon";
import styles from "@/components/auth-page.module.css";

type PhoneAuthStatus = "disabled" | "unavailable" | "available";
type EmailAuthStatus = "disabled" | "unavailable" | "available";
type RegistrationMethod = "email" | "phone" | "legacy";

type RegisterFormProps = {
  localRegistrationEnabled: boolean;
  phoneAuthStatus?: PhoneAuthStatus;
  emailAuthStatus?: EmailAuthStatus;
};

export function RegisterForm({
  localRegistrationEnabled,
  phoneAuthStatus = "disabled",
  emailAuthStatus = "disabled",
}: RegisterFormProps) {
  const router = useRouter();
  const t = useTranslate();
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsChallengeId, setSmsChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [method, setMethod] = useState<RegistrationMethod>(() => emailAuthStatus !== "disabled" ? "email" : phoneAuthStatus !== "disabled" ? "phone" : "legacy");
  const [step, setStep] = useState<1 | 2>(1);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const emailAvailable = emailAuthStatus !== "disabled";
  const phoneAvailable = phoneAuthStatus !== "disabled";
  const emailVerificationRequired = method === "email";
  const phoneVerificationRequired = method === "phone";
  const verificationRequired = method !== "legacy";

  function continueToCredentials() {
    setError(null);
    if (emailVerificationRequired) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()) || email.length > 320) {
        setError("请输入有效的邮箱地址。");
        return;
      }
      if (emailAuthStatus !== "available") {
        setError("邮箱验证暂不可用，请稍后重试或联系管理员。");
        return;
      }
      if (!emailChallengeId || emailCode.length !== 6) {
        setError("请先获取并填写邮箱验证码。");
        return;
      }
    } else if (phoneVerificationRequired) {
      if (!/^1[3-9][0-9]{9}$/u.test(phone)) {
        setError("请输入有效的中国大陆手机号。");
        return;
      }
      if (phoneAuthStatus !== "available") {
        setError("手机号验证暂不可用，请稍后重试或联系管理员。");
        return;
      }
      if (!smsChallengeId || smsCode.length !== 6) {
        setError("请先获取并填写短信验证码。");
        return;
      }
    }
    setStep(2);
  }

  function changeMethod(nextMethod: "email" | "phone") {
    if (nextMethod === method) return;
    setMethod(nextMethod);
    setStep(1);
    setError(null);
    setEmailCode("");
    setEmailChallengeId(null);
    setSmsCode("");
    setSmsChallengeId(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (verificationRequired && step === 1) {
      continueToCredentials();
      return;
    }
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

  const contactLabel = emailVerificationRequired ? "待验证邮箱" : "待验证手机号";
  const contactValue = emailVerificationRequired ? email : `+86 ${phone}`;

  return (
    <div className={styles.formBody}>
      <div className={styles.formHeading}>
        <p className={styles.formEyebrow}>{t("开始使用")}</p>
        <h2>{t(verificationRequired && step === 2 ? "设置你的账号" : "创建账号")}</h2>
        <p>{t(verificationRequired ? step === 1 ? "用常用邮箱或手机号开始。" : "设置用户名和密码。" : "设置登录账号和密码。")}</p>
      </div>
      {localRegistrationEnabled ? (
        <form onSubmit={submit} className={styles.registerForm}>
          {verificationRequired ? (
            <div className={styles.flowSteps} aria-label={t("第 {step} 步，共 2 步").replace("{step}", String(step))}>
              <span className={`${styles.flowStep} ${step === 1 ? styles.flowStepActive : styles.flowStepDone}`} aria-current={step === 1 ? "step" : undefined}>
                <i>{step === 1 ? "1" : <ShellIcon name="check" className="app-icon--meta" />}</i>{t("联系方式")}
              </span>
              <span className={styles.flowConnector} />
              <span className={`${styles.flowStep} ${step === 2 ? styles.flowStepActive : ""}`} aria-current={step === 2 ? "step" : undefined}>
                <i>2</i>{t("账号设置")}
              </span>
            </div>
          ) : null}

          {emailAvailable && phoneAvailable ? (
            <fieldset disabled={pending || step !== 1} data-hidden={step !== 1} className={styles.methodOptions}>
              <legend>{t("注册验证方式")}</legend>
              <label className={styles.choiceLabel}>
                <input type="radio" name="registration-method" checked={method === "email"} onChange={() => changeMethod("email")} className={styles.choiceInput} />
                <span>{t("邮箱")}</span>
              </label>
              <label className={styles.choiceLabel}>
                <input type="radio" name="registration-method" checked={method === "phone"} onChange={() => changeMethod("phone")} className={styles.choiceInput} />
                <span>{t("手机号")}</span>
              </label>
            </fieldset>
          ) : null}

          {verificationRequired ? (
            <fieldset disabled={pending || step !== 1} data-hidden={step !== 1} className={`${styles.registerFieldset} ${styles.stepPanel}`}>
              {emailAvailable ? (
                <fieldset disabled={method !== "email"} data-hidden={method !== "email"} className={styles.stepPanel}>
                  <div className={styles.verificationFields}>
                    <div>
                      <label htmlFor="register-email" className={styles.fieldLabel}>{t("邮箱")}</label>
                      <input
                        id="register-email"
                        type="email"
                        value={email}
                        onChange={(event) => { setEmail(event.target.value); setEmailCode(""); setEmailChallengeId(null); }}
                        autoComplete="email"
                        maxLength={320}
                        required
                        placeholder={t("输入常用邮箱")}
                        className={styles.fieldInput}
                      />
                      <p className={styles.fieldHint}>{t("验证码用于验证邮箱；系统不会提供邮件找回密码。")}</p>
                    </div>
                    <div className={styles.emailCodeField}>
                      <EmailCodeInput key={email} id="register-email-code" email={email} purpose="register" availability={emailAuthStatus === "available" ? "available" : "unavailable"} code={emailCode} onCodeChange={setEmailCode} onChallengeIdChange={setEmailChallengeId} />
                    </div>
                  </div>
                </fieldset>
              ) : null}

              {phoneAvailable ? (
                <fieldset disabled={method !== "phone"} data-hidden={method !== "phone"} className={styles.stepPanel}>
                  <div className={styles.verificationFields}>
                    <div>
                      <label htmlFor="register-phone" className={styles.fieldLabel}>{t("手机号")}</label>
                      <div className={styles.phoneShell}>
                        <span aria-hidden="true" className={styles.phonePrefix}>+86</span>
                        <input
                          id="register-phone"
                          type="tel"
                          inputMode="numeric"
                          value={phone}
                          onChange={(event) => { setPhone(normalizeMainlandPhoneInput(event.target.value)); setSmsCode(""); setSmsChallengeId(null); }}
                          autoComplete="tel-national"
                          minLength={11}
                          maxLength={11}
                          required
                          pattern="1[3-9][0-9]{9}"
                          placeholder={t("输入 11 位手机号")}
                          className={styles.phoneInput}
                        />
                      </div>
                      <p className={styles.fieldHint}>{t("仅支持中国大陆手机号。")}</p>
                    </div>
                    <div className={styles.smsCodeField}>
                      <SmsCodeInput key={phone} id="register-sms-code" phoneE164={`+86${phone}`} purpose="register" availability={phoneAuthStatus === "available" ? "available" : "unavailable"} code={smsCode} onCodeChange={setSmsCode} onChallengeIdChange={setSmsChallengeId} />
                    </div>
                  </div>
                </fieldset>
              ) : null}

              {error && step === 1 ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}
              <button type="button" onClick={continueToCredentials} className={styles.submitButton}>{t("继续设置账号")}</button>
              <p className={styles.fieldHint}>{t("验证码将在创建账号时一并核验。")}</p>
            </fieldset>
          ) : null}

          {(method === "legacy" || step === 2) ? (
            <>
              {verificationRequired ? (
                <div className={styles.identitySummary}>
                  <div><span>{t(contactLabel)}</span><strong>{contactValue}</strong></div>
                  <button type="button" disabled={pending} onClick={() => { setStep(1); setError(null); }}>{t("修改")}</button>
                </div>
              ) : null}
              <fieldset disabled={pending || (verificationRequired && step !== 2)} className={styles.registerFieldset}>
                <div className={`${styles.passwordFields} ${styles.registerCredentialFields}`}>
                  <div>
                    <label htmlFor="register-username" className={styles.fieldLabel}>{t("用户名")}</label>
                    <input
                      id="register-username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      minLength={3}
                      maxLength={64}
                      required
                      pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}"}
                      title={t("3 至 64 个字符，以字母或数字开头，只能使用字母、数字、点、下划线和连字符。")}
                      placeholder={t("例如 project.owner")}
                      className={styles.fieldInput}
                    />
                    <p className={styles.fieldHint}>{t("3–64 位，支持字母、数字和 . _ -；统一为小写。")}</p>
                  </div>
                  <div>
                    <label htmlFor="register-password" className={styles.fieldLabel}>{t("密码")}</label>
                    <div className={styles.passwordShell}>
                      <input id="register-password" type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required className={styles.passwordInput} />
                      <button type="button" className={styles.passwordToggle} aria-label={t(passwordVisible ? "隐藏密码" : "显示密码")} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((current) => !current)}><ShellIcon name={passwordVisible ? "eye-off" : "eye"} className="app-icon--control" /></button>
                    </div>
                    <p className={styles.fieldHint}>{t("8–128 位，并同时包含英文字母和数字。")}</p>
                  </div>
                  <div>
                    <label htmlFor="register-confirm-password" className={styles.fieldLabel}>{t("确认密码")}</label>
                    <div className={styles.passwordShell}>
                      <input id="register-confirm-password" type={confirmationVisible ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required className={styles.passwordInput} />
                      <button type="button" className={styles.passwordToggle} aria-label={t(confirmationVisible ? "隐藏密码" : "显示密码")} aria-pressed={confirmationVisible} onClick={() => setConfirmationVisible((current) => !current)}><ShellIcon name={confirmationVisible ? "eye-off" : "eye"} className="app-icon--control" /></button>
                    </div>
                  </div>
                </div>

                <label className={styles.rememberLabel}>
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className={styles.rememberInput} />
                  <span>{t("保持登录")}</span>
                </label>

                {method === "legacy" ? <p className={`${styles.notice} ${styles.noticeWarning}`}>
                  {t("请妥善保管用户名和密码；当前没有可用的邮箱或手机号验证通道。")}
                </p> : null}
                {error && (step === 2 || method === "legacy") ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}
                <button type="submit" disabled={pending || (emailVerificationRequired && emailAuthStatus !== "available") || (phoneVerificationRequired && phoneAuthStatus !== "available")} className={styles.submitButton}>{pending ? t("正在创建账号…") : t("创建账号")}</button>
              </fieldset>
            </>
          ) : null}
        </form>
      ) : (
        <p className={`${styles.notice} ${styles.noticeWarning}`}>{t("本地用户名和密码注册暂未开放。请返回登录页使用其他可用方式，或联系管理员。")}</p>
      )}
    </div>
  );
}
