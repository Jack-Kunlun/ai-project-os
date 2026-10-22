"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";


import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import styles from "@/components/auth-page.module.css";

type PhoneAuthStatus = "disabled" | "unavailable" | "available";

type LoginFormProps = {
  notice?: string;
  noticeTone?: "success" | "error";
  oidcProviders?: Array<{ id: string; name: string }>;
  returnTo?: string;
  githubLoginAvailable?: boolean;
  githubAvailability?: "notConfigured" | "configurationInvalid" | "bootstrapPending" | "available";
  phoneAuthStatus?: PhoneAuthStatus;
  phoneAutoRegistrationEnabled?: boolean;
  emailAuthEnabled?: boolean;
};

export function LoginForm({
  notice,
  noticeTone = "success",
  oidcProviders = [],
  returnTo = "/dashboard",
  githubLoginAvailable = false,
  githubAvailability = githubLoginAvailable ? "available" : "notConfigured",
  phoneAuthStatus = "disabled",
  phoneAutoRegistrationEnabled = false,
  emailAuthEnabled = false,
}: LoginFormProps) {
  const router = useRouter();
  const t = useTranslate();
  const [method, setMethod] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsChallengeId, setSmsChallengeId] = useState<string | null>(null);
  const remember = true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smsSuccessNotice, setSmsSuccessNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (method === "sms" && phoneAuthStatus !== "available") return;
    setPending(true);
    setError(null);
    setSmsSuccessNotice(null);
    try {
      if (method === "sms") {
        if (!smsChallengeId || smsCode.length !== 6) {
          throw new Error("请先获取并填写短信验证码。");
        }
        const response = await fetch("/api/auth/sms/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: `+86${phone}`, challengeId: smsChallengeId, code: smsCode, remember }),
        });
        const payload = await response.json().catch(() => null) as {
          error?: { code?: string };
          user?: { role?: "admin" | "user" };
          registered?: boolean;
        } | null;
        if (!response.ok || !payload?.user?.role) {
          const safeMessage = payload?.error?.code === "LOCAL_REGISTRATION_DISABLED"
            ? "该手机号尚未注册，当前暂未开放新账号注册。"
            : "验证码登录失败，请检查验证码或稍后重试。";
          throw new Error(safeMessage);
        }
        if (payload.registered === true && phoneAutoRegistrationEnabled) {
          setSmsSuccessNotice("该手机号尚未注册，已为你创建账号和个人工作区。");
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
        router.replace(payload.user.role === "admin" ? "/admin" : returnTo);
        router.refresh();
        return;
      }

      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "登录失败");
      }
      const payload = await response.json() as { user: { role: "admin" | "user" } };
      router.replace(payload.user.role === "admin" ? "/admin" : returnTo);
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setPending(false);
    }
  }

  const githubHref = `/api/auth/github/start?intent=login&remember=${remember ? "true" : "false"}&returnTo=${encodeURIComponent(returnTo)}`;
  const githubUnavailableMessage = {
    notConfigured: "GitHub 登录尚未配置，请联系工作区管理员",
    configurationInvalid: "GitHub 登录配置无效，请联系工作区管理员",
    bootstrapPending: "平台管理员尚未完成初始化，GitHub 登录暂不可用",
    available: "",
  }[githubAvailability];
  const smsLoginAvailable = phoneAuthStatus === "available";

  function changeLoginMethod(nextMethod: "password" | "sms") {
    if (nextMethod === "sms" && !smsLoginAvailable) return;
    setMethod(nextMethod);
    setError(null);
    setSmsCode("");
    setSmsChallengeId(null);
  }

  return (
          <form onSubmit={submit} className={styles.form}>
            <div className={styles.formHeading}>
              <p className={styles.formEyebrow}>{t("欢迎回来")}</p>
              <h2>{t("登录 AI Project OS")}</h2>
              <p>{t("使用你的账号进入工作区。")}</p>
            </div>

            {phoneAuthStatus !== "disabled" ? (
              <div className={styles.methodSection}>
                <div role="tablist" aria-label={t("选择登录方式")} className={styles.methodTabs}>
                  <button type="button" role="tab" aria-selected={method === "password"} onClick={() => changeLoginMethod("password")} className={`${styles.methodTab} ${method === "password" ? styles.methodTabSelected : ""}`}>{t("用户名密码")}</button>
                  <button type="button" role="tab" aria-selected={method === "sms"} disabled={!smsLoginAvailable} onClick={() => changeLoginMethod("sms")} className={`${styles.methodTab} ${method === "sms" ? styles.methodTabSelected : ""}`}>{t("手机号验证码")}</button>
                </div>
                {smsLoginAvailable ? (
                  <p className={styles.methodHint}>
                    {t(phoneAutoRegistrationEnabled ? "验证码验证后登录；手机号首次使用时会自动创建账号和个人工作区。" : "验证码用于登录已有账号；如需新账号，请先完成注册。")}
                  </p>
                ) : <p role="status" className={`${styles.methodHint} ${styles.statusWarning}`}>{t("短信服务暂不可用，请稍后重试或联系管理员。")}</p>}
              </div>
            ) : null}

            {method === "password" ? (
              <>
                <label className={styles.fieldLabel} htmlFor="login-username">{t(emailAuthEnabled ? "用户名、手机号或已验证邮箱" : "用户名或手机号")}</label>
                <div className={styles.inputShell}>
                  <span className={styles.inputIcon}><UserIcon /></span>
                  <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={emailAuthEnabled ? 320 : 64} required placeholder={t(emailAuthEnabled ? "输入用户名、手机号或已验证邮箱" : "输入用户名或手机号")} className={styles.textInput} />
                </div>

                <label className={`${styles.fieldLabel} ${styles.nextFieldLabel}`} htmlFor="login-password">{t("密码")}</label>
                <div className={styles.inputShell}>
                  <span className={styles.inputIcon}><LockIcon /></span>
                  <div className={styles.passwordShell}>
                    <input id="login-password" type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder={t("输入密码")} className={styles.passwordInput} />
                    <button type="button" className={styles.passwordToggle} aria-label={t(passwordVisible ? "隐藏密码" : "显示密码")} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((current) => !current)}><ShellIcon name={passwordVisible ? "eye-off" : "eye"} className="app-icon--control" /></button>
                  </div>
                </div>
              </>
            ) : null}

            <fieldset disabled={method !== "sms"} data-hidden={method !== "sms"} className={`${styles.smsFields} ${styles.stepPanel}`}>
                <div className={styles.smsPhoneField}>
                  <label className={styles.fieldLabel} htmlFor="login-phone">{t("手机号")}</label>
                  <div className={styles.phoneShell}>
                    <span aria-hidden="true" className={styles.phonePrefix}>+86</span>
                    <input
                      id="login-phone"
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
                      placeholder={t("输入 11 位手机号")}
                      className={styles.phoneInput}
                    />
                  </div>
                </div>
                <div className={styles.smsCodeField}>
                  <SmsCodeInput
                    id="login-sms-code"
                    size="large"
                    phoneE164={`+86${phone}`}
                    purpose="login"
                    availability="available"
                    code={smsCode}
                    onCodeChange={setSmsCode}
                    onChallengeIdChange={setSmsChallengeId}
                  />
                </div>
            </fieldset>

            {method === "password" ? (
              <div className={styles.recoverLink}>
                <Link href="/recover">{t("忘记账号或密码？")}</Link>
              </div>
            ) : null}

            {notice ? <p role={noticeTone === "error" ? "alert" : "status"} className={`${styles.notice} ${noticeTone === "error" ? styles.noticeError : styles.noticeSuccess}`}><UiFeedbackText text={notice} /></p> : null}
            {smsSuccessNotice ? <p role="status" className={`${styles.notice} ${styles.noticeSuccess}`}>{t(smsSuccessNotice)}</p> : null}
            {error ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}><UiErrorText text={error} /></p> : null}

            <button type="submit" disabled={pending} className={styles.submitButton}>{pending ? t("登录中…") : t("登 录")}</button>

            <p className={styles.registerPrompt}>{t("还没有账号？")} <Link href="/register">{t("创建账号")}</Link></p>

            <div className={styles.alternativeHeading}><span />{t("其他登录方式")}<span /></div>

            {githubLoginAvailable ? (
              <div className={styles.providerBlock}>
                <a href={githubHref} className={styles.providerLink}><GitHubIcon />{t("使用 GitHub 登录")}</a>
                <p className={styles.providerHint}>{t("首次使用 GitHub 登录会自动创建普通用户账号。")}</p>
              </div>
            ) : (
              <div className={styles.providerBlock}>
                <button type="button" disabled className={`${styles.providerLink} ${styles.providerUnavailable}`}><GitHubIcon />{t("使用 GitHub 登录")}</button>
                <p className={styles.providerHint}>{t(githubUnavailableMessage)}</p>
              </div>
            )}

            {oidcProviders.length > 0 ? <div className={styles.oidcProviders}>{oidcProviders.map((provider) => <a key={provider.id} href={`/api/auth/oidc/start/${provider.id}?returnTo=${encodeURIComponent(returnTo)}`} className={styles.oidcLink}>{t("使用 {provider} 登录").replace("{provider}", provider.name)}</a>)}</div> : null}
          </form>
  );
}

function UserIcon() { return <ShellIcon name="person" className="app-icon--control" />; }
function LockIcon() { return <ShellIcon name="lock" className="app-icon--control" />; }
function GitHubIcon() { return <ShellIcon name="github" className="app-icon--feature" />; }
